// The editor the iOS app loads into a WKWebView. The document comes from
// @pikos/editor-schema, so a page written here is byte-identical to one written on desktop.
//
// The webview never talks to the database: it reports what changed and Swift decides what
// to store.

import { extractText } from "@pikos/core";
import { createDocumentExtensions, createPikosImageNode } from "@pikos/editor-schema";
import { Editor } from "@tiptap/core";

import { resolveAssetUrl } from "./assetUrl";
import { debounce, hasHost, send } from "./bridge";
import { createInputTimings } from "./inputTimings";
import { parseHostMessage, PROTOCOL_VERSION } from "./protocol";

/** Short enough that a backgrounding flush rarely has anything to do, long enough to collapse a burst of keystrokes. */
const DOC_CHANGE_DEBOUNCE_MS = 300;

let currentPageId: string | null = null;

/** Guards against echoing the host's own `load` back as a change. */
let applyingHostDocument = false;

const inputTimings = createInputTimings();

function mount(): Editor {
  const element = document.querySelector<HTMLElement>("#editor");
  if (!element) throw new Error("#editor element is missing from the document");

  const sendDocChanged = debounce((editor: Editor) => {
    if (currentPageId === null) return;
    const doc = editor.getJSON();
    send("docChanged", {
      doc: JSON.stringify(doc),
      pageId: currentPageId,
      // The desktop's FTS extractor, so search behaves identically on both.
      plainText: extractText(doc),
    });
    const timing = inputTimings.drain();
    if (timing) send("inputTiming", timing);
  }, DOC_CHANGE_DEBOUNCE_MS);

  element.addEventListener("beforeinput", () => inputTimings.start());

  const editor = new Editor({
    element,
    extensions: [
      ...createDocumentExtensions({
        image: createPikosImageNode(resolveAssetUrl),
        resolveAssetUrl,
      }),
    ],
    // Also on focus: tapping in where the caret already sits fires no selection update, and
    // the native toolbar would keep the last page's state.
    onFocus: ({ editor: e }) => reportSelection(e),
    onSelectionUpdate: ({ editor: e }) => reportSelection(e),
    onUpdate: ({ editor: e }) => {
      // A host-initiated load fires onUpdate too; echoing it makes every page open look like an edit.
      if (applyingHostDocument) return;
      inputTimings.finishOnNextFrame();
      sendDocChanged(e);
      reportHeight(element);
    },
  });

  // The schema sets `openOnClick: false`, so a link tap does nothing by itself. The host
  // opens it: a webview that navigated would replace the editor with a web page.
  element.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    send("linkTapped", { url: href });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendDocChanged.flush();
  });
  window.addEventListener("pagehide", () => sendDocChanged.flush());

  return editor;
}

function reportSelection(editor: Editor): void {
  const { $from, empty } = editor.state.selection;
  send("selectionChanged", {
    isEmpty: empty,
    marks: Object.keys(editor.schema.marks).filter((mark) => editor.isActive(mark)),
    nodeType: $from.parent.type.name,
  });
}

let lastReportedHeight = 0;

function reportHeight(element: HTMLElement): void {
  const px = Math.ceil(element.getBoundingClientRect().height);
  // Sub-pixel jitter would otherwise send a message per keystroke.
  if (Math.abs(px - lastReportedHeight) < 1) return;
  lastReportedHeight = px;
  send("heightChanged", { px });
}

function applyTheme(scheme: string, accent: string): void {
  const root = document.documentElement;
  root.dataset["scheme"] = scheme === "dark" ? "dark" : "light";
  root.style.setProperty("--pikos-accent", accent);
}

function handleHostMessage(editor: Editor, raw: unknown): void {
  const parsed = parseHostMessage(raw);
  if (!parsed.ok) {
    // A throw here is swallowed by the JS evaluation context, so the host would see only a generic failure.
    // eslint-disable-next-line no-console
    console.error("[pikos-bridge]", parsed.error);
    return;
  }

  switch (parsed.type) {
    case "load": {
      const { doc, pageId } = parsed.payload as { doc: string; pageId: string };
      currentPageId = pageId;
      applyingHostDocument = true;
      try {
        // addToHistory: false keeps undo from reverting a freshly opened page to the empty
        // document, which shake-to-undo makes easy to hit. applyingHostDocument also covers
        // the transactions Tiptap runs while normalising, which emitUpdate: false does not.
        editor
          .chain()
          .setMeta("addToHistory", false)
          .setContent(JSON.parse(doc) as object, { emitUpdate: false })
          .run();
      } catch {
        // Clear rather than leave the previous page's content showing.
        editor.commands.clearContent();
        // eslint-disable-next-line no-console
        console.error("[pikos-bridge] could not parse the document for", pageId);
      } finally {
        applyingHostDocument = false;
      }
      return;
    }
    case "setTheme": {
      const { accent, scheme } = parsed.payload as { accent: string; scheme: string };
      applyTheme(scheme, accent);
      return;
    }
    case "setEditable": {
      const { editable } = parsed.payload as { editable: boolean };
      // Blur too: a read-only surface that kept the keyboard would show it for a page that
      // cannot take a keystroke.
      editor.setEditable(editable);
      if (!editable) editor.commands.blur();
      return;
    }
    case "focus":
      editor.commands.focus();
      return;
    case "blur":
      editor.commands.blur();
      return;
    case "insertImage": {
      const { assetPath } = parsed.payload as { assetPath: string };
      editor.commands.insertContent({
        attrs: { "data-asset-path": assetPath, src: assetPath },
        type: "image",
      });
      return;
    }
    case "toggleMark": {
      const { mark } = parsed.payload as { mark: string };
      toggleMark(editor, mark);
      return;
    }
    case "toggleBlock": {
      const { headingLevel, nodeType } = parsed.payload as {
        headingLevel: number;
        nodeType: string;
      };
      toggleBlock(editor, nodeType, headingLevel);
      return;
    }
  }
}

/** An allowlist, since the name arrives from outside the webview and is passed to the editor's chain. */
const TOGGLEABLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);

function toggleMark(editor: Editor, mark: string): void {
  if (!TOGGLEABLE_MARKS.has(mark)) {
    // eslint-disable-next-line no-console
    console.warn("[pikos-bridge] unknown mark:", mark);
    return;
  }
  // focus() first: the native toolbar takes focus when tapped, leaving no current selection.
  editor.chain().focus().toggleMark(mark).run();
}

function toggleBlock(editor: Editor, nodeType: string, headingLevel: number): void {
  const chain = editor.chain().focus();
  switch (nodeType) {
    case "paragraph":
      chain.setParagraph().run();
      return;
    case "heading": {
      // The schema declares levels 1-3; anything else is dropped on the next parse.
      const level = Math.min(3, Math.max(1, Math.round(headingLevel))) as 1 | 2 | 3;
      chain.toggleHeading({ level }).run();
      return;
    }
    case "bulletList":
      chain.toggleBulletList().run();
      return;
    case "orderedList":
      chain.toggleOrderedList().run();
      return;
    case "taskList":
      chain.toggleTaskList().run();
      return;
    case "blockquote":
      chain.toggleBlockquote().run();
      return;
    case "codeBlock":
      chain.toggleCodeBlock().run();
      return;
    default:
      // eslint-disable-next-line no-console
      console.warn("[pikos-bridge] unknown block type:", nodeType);
  }
}

interface PikosWebviewApi {
  receive: (raw: unknown) => void;
}

declare global {
  interface Window {
    pikosEditor?: PikosWebviewApi;
  }
}

function start(): void {
  const editor = mount();

  // One entry point for the host's evaluateJavaScript, so there is one place to validate.
  window.pikosEditor = {
    receive: (raw: unknown) => handleHostMessage(editor, raw),
  };

  send("ready", { protocolVersion: PROTOCOL_VERSION });

  if (!hasHost()) {
    // Standalone in a browser: something to type into.
    editor.commands.setContent({
      content: [
        {
          content: [{ text: "Pikos editor — no host attached.", type: "text" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    });
  }
}

start();
