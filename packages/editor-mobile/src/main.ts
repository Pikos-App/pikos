// The editor the iOS app loads into a WKWebView. The document comes from @pikos/editor-schema,
// so a page written here is byte-identical to one written on desktop; behaviour is local and
// differs on purpose (no Tab key, a keyboard covering half the screen).
//
// The webview never talks to the database. It reports what changed; Swift decides what to store.

import { extractText } from "@pikos/core";
import { createDocumentExtensions, createPikosImageNode } from "@pikos/editor-schema";
import { createDocument, Editor } from "@tiptap/core";

import { resolveAssetUrl } from "./assetUrl";
import { debounce, hasHost, send } from "./bridge";
import { createInputTimings } from "./inputTimings";
import { parseHostMessage, PROTOCOL_VERSION } from "./protocol";

/**
 * How long to wait after typing stops before sending the document to the host. Every send
 * serialises the full document plus its plain text across the bridge, so a burst of keystrokes
 * should collapse into one message, yet stay short enough that a backgrounded-app flush
 * (`bridge.flush`) rarely has anything to do.
 */
const DOC_CHANGE_DEBOUNCE_MS = 300;

let currentPageId: string | null = null;

/** Guards against echoing the host's own `load` back as a change. */
let applyingHostDocument = false;

/** docChanged messages sent since the open page loaded, matched against a reload's `changesSeen`. */
let changesSent = 0;

const inputTimings = createInputTimings();

interface Mounted {
  editor: Editor;
  /** Typing still inside the debounce, which no docChanged has carried yet. */
  hasUnsentChange: () => boolean;
}

function mount(): Mounted {
  const element = document.querySelector<HTMLElement>("#editor");
  if (!element) throw new Error("#editor element is missing from the document");

  const sendDocChanged = debounce((editor: Editor) => {
    if (currentPageId === null) return;
    changesSent += 1;
    const doc = editor.getJSON();
    send("docChanged", {
      doc: JSON.stringify(doc),
      pageId: currentPageId,
      // Extracted here with the desktop's FTS function, so search behaves the same on both.
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
    // Tiptap's selection update fires only when the selection moves, so tapping in where the
    // caret already sits, or toggling a mark from the toolbar, reported nothing and the button
    // stayed unlit.
    onFocus: ({ editor: e }) => reportSelection(e),
    onTransaction: ({ editor: e, transaction }) => {
      const mayChangeToolbar =
        transaction.selectionSet || transaction.storedMarksSet || transaction.docChanged;
      if (mayChangeToolbar) reportSelection(e);
    },
    onUpdate: ({ editor: e }) => {
      // A host load fires onUpdate too; echoing it would make every page open look like an edit.
      if (applyingHostDocument) return;
      inputTimings.finishOnNextFrame();
      sendDocChanged(e);
      reportHeight(element);
    },
  });

  // The schema sets `openOnClick: false`, so a tapped link is inert unless reported. The host
  // acts on it: a webview that navigated would replace the editor with a web page.
  element.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    send("linkTapped", { url: href });
  });

  // iOS can suspend the process soon after backgrounding, taking a pending debounce with it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendDocChanged.flush();
  });
  window.addEventListener("pagehide", () => sendDocChanged.flush());

  return { editor, hasUnsentChange: sendDocChanged.isPending };
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

/**
 * Replaces the document with `doc` by changing only the stretch that differs, so the caret and
 * scroll stay with the text around them. A full reset with the caret restored at the same offset
 * would land it in other text whenever the change sat above it.
 */
function showInPlace(editor: Editor, doc: string): boolean {
  const next = parseDocument(editor, doc);
  if (!next) return false;

  const current = editor.state.doc;
  const start = current.content.findDiffStart(next.content);
  if (start === null) return true;

  const ends = current.content.findDiffEnd(next.content);
  if (!ends) return true;

  // Counted back from the end, a change that repeats the text beside it can end before it starts.
  const overlap = Math.max(0, start - Math.min(ends.a, ends.b));
  const tr = editor.state.tr
    .replace(start, ends.a + overlap, next.slice(start, ends.b + overlap))
    .setMeta("addToHistory", false);

  applyingHostDocument = true;
  try {
    editor.view.dispatch(tr);
  } finally {
    applyingHostDocument = false;
  }
  return true;
}

function parseDocument(editor: Editor, doc: string): ReturnType<typeof createDocument> | null {
  try {
    return createDocument(JSON.parse(doc) as object, editor.schema, undefined, {
      errorOnInvalidContent: true,
    });
  } catch {
    // eslint-disable-next-line no-console
    console.error("[pikos-bridge] could not parse a newer body for", currentPageId);
    return null;
  }
}

function handleHostMessage({ editor, hasUnsentChange }: Mounted, raw: unknown): void {
  const parsed = parseHostMessage(raw);
  if (!parsed.ok) {
    // Logged, not thrown: the JS evaluation context swallows a throw and the host sees only a
    // generic failure.
    // eslint-disable-next-line no-console
    console.error("[pikos-bridge]", parsed.error);
    return;
  }

  switch (parsed.type) {
    case "load": {
      const { doc, pageId } = parsed.payload as { doc: string; pageId: string };
      currentPageId = pageId;
      changesSent = 0;
      applyingHostDocument = true;
      try {
        // addToHistory: false keeps undo on a freshly opened page from reverting to the empty
        // document (shake-to-undo makes that easy to hit). emitUpdate: false stops the load
        // reporting as a change, and applyingHostDocument covers the transactions Tiptap runs
        // while normalising, which emitUpdate does not.
        editor
          .chain()
          .setMeta("addToHistory", false)
          .setContent(JSON.parse(doc) as object, { emitUpdate: false })
          .run();
      } catch {
        // A corrupt document must not leave the previous page's content on screen.
        editor.commands.clearContent();
        // eslint-disable-next-line no-console
        console.error("[pikos-bridge] could not parse the document for", pageId);
      } finally {
        applyingHostDocument = false;
      }
      return;
    }
    case "reload": {
      const { changesSeen, doc, pageId } = parsed.payload as {
        changesSeen: number;
        doc: string;
        pageId: string;
      };
      const isOpenPage = pageId === currentPageId;
      const hasHostEveryChange = changesSeen === changesSent && !hasUnsentChange();
      const applied = isOpenPage && hasHostEveryChange && showInPlace(editor, doc);
      send("reloadResult", { applied, pageId });
      return;
    }
    case "setTheme": {
      const { accent, scheme } = parsed.payload as { accent: string; scheme: string };
      applyTheme(scheme, accent);
      return;
    }
    case "setEditable": {
      const { editable } = parsed.payload as { editable: boolean };
      // Blur too: a read-only surface that kept the keyboard would show one for a page that
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

/** Marks the host may toggle. An allowlist because the name comes from outside the webview, and `chain()[name]()` on an arbitrary string calls anything the editor exposes. */
const TOGGLEABLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);

function toggleMark(editor: Editor, mark: string): void {
  if (!TOGGLEABLE_MARKS.has(mark)) {
    // eslint-disable-next-line no-console
    console.warn("[pikos-bridge] unknown mark:", mark);
    return;
  }
  // focus() first: the native toolbar takes focus when tapped, so the selection is stale otherwise.
  editor.chain().focus().toggleMark(mark).run();
}

function toggleBlock(editor: Editor, nodeType: string, headingLevel: number): void {
  const chain = editor.chain().focus();
  switch (nodeType) {
    case "paragraph":
      chain.setParagraph().run();
      return;
    case "heading": {
      // The schema declares levels 1-3; another level is dropped on the next parse.
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
  const mounted = mount();
  const { editor } = mounted;

  // One entry point for evaluateJavaScript, so there is one place to version and validate.
  window.pikosEditor = {
    receive: (raw: unknown) => handleHostMessage(mounted, raw),
  };

  send("ready", { protocolVersion: PROTOCOL_VERSION });

  if (!hasHost()) {
    // Standalone in a browser: give it content so the editor works without the app.
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
