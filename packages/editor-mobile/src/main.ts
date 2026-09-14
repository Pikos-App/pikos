// The editor the iOS app loads into a WKWebView.
//
// Everything that decides the *document* comes from @pikos/editor-schema, so a
// page written here is byte-identical to one written on desktop. Everything
// that decides *behaviour* is local to this file and deliberately different: a
// phone has no Tab key, no slash-menu ergonomics worth speaking of, and a
// keyboard that covers half the screen.
//
// The one rule from the plan that shapes the whole file: the webview never
// talks to the database. It reports what changed; Swift decides what to store.

import { extractText } from "@pikos/core";
import { createDocumentExtensions, createPikosImageNode } from "@pikos/editor-schema";
import { Editor } from "@tiptap/core";

import { debounce, hasHost, send } from "./bridge";
import { parseHostMessage, PROTOCOL_VERSION } from "./protocol";

/**
 * How long to wait after typing stops before sending the document to the host.
 *
 * Every send serialises the full document plus its extracted plain text and
 * crosses the bridge, so coalescing matters at typing speed. 300ms is short
 * enough that a backgrounded app flush (see `bridge.flush`) rarely has anything
 * to do, and long enough to collapse a burst of keystrokes into one message.
 * The M0 spike should confirm this against a real device rather than trust it.
 */
const DOC_CHANGE_DEBOUNCE_MS = 300;

/**
 * Assets are served by a custom WKURLSchemeHandler registered by the host.
 *
 * A custom scheme rather than file:// because WKWebView treats file:// as a
 * distinct, heavily restricted origin — loading the editor from one and images
 * from another runs into cross-origin rules that have no workaround worth
 * having.
 */
const ASSET_SCHEME = "pikos-asset";

function resolveAssetUrl(path: string): string {
  return `${ASSET_SCHEME}://asset/${encodeURI(path)}`;
}

let currentPageId: string | null = null;

/** Guards against echoing the host's own `load` back as a change. */
let applyingHostDocument = false;

function mount(): Editor {
  const element = document.querySelector<HTMLElement>("#editor");
  if (!element) throw new Error("#editor element is missing from the document");

  const sendDocChanged = debounce((editor: Editor) => {
    if (currentPageId === null) return;
    const doc = editor.getJSON();
    send("docChanged", {
      doc: JSON.stringify(doc),
      pageId: currentPageId,
      // Extracted here rather than on the host: it is the same function the
      // desktop app uses for the FTS column, so search behaves identically for
      // a page typed on the phone.
      plainText: extractText(doc),
    });
  }, DOC_CHANGE_DEBOUNCE_MS);

  const editor = new Editor({
    element,
    extensions: [
      ...createDocumentExtensions({
        image: createPikosImageNode(resolveAssetUrl),
        resolveAssetUrl,
      }),
    ],
    // Reported on focus as well as on selection change. ProseMirror only fires
    // a selection update when the selection actually moves, so tapping into the
    // document where the caret already sits produces nothing — and a native
    // toolbar that only listens for movement would sit there showing whatever
    // the last page's caret was under.
    onFocus: ({ editor: e }) => reportSelection(e),
    onSelectionUpdate: ({ editor: e }) => reportSelection(e),
    onUpdate: ({ editor: e }) => {
      // A host-initiated load fires onUpdate too. Sending that back would have
      // the host persist a document it just supplied — harmless in isolation,
      // but it makes every page open look like an edit in the change log.
      if (applyingHostDocument) return;
      sendDocChanged(e);
      reportHeight(element);
    },
  });

  // Tapping a link reports it to the host, which decides whether to open it.
  //
  // The schema sets `openOnClick: false` — correct for an editor, where a tap
  // should place the caret rather than navigate — so nothing happens on its
  // own. On desktop the app supplies the rest; here, without this, a link in a
  // page was simply inert. The host must be the one to act on it in any case:
  // a webview that navigated would replace the editor with a web page.
  element.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    // The caret still moves; only the navigation is refused, and there is none
    // to refuse unless the browser decided to follow the href itself.
    event.preventDefault();
    send("linkTapped", { url: href });
  });

  // iOS can suspend the process shortly after backgrounding, which would take a
  // pending debounce — and the user's last keystrokes — with it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendDocChanged.flush();
  });
  window.addEventListener("pagehide", () => sendDocChanged.flush());

  return editor;
}

/** Tell the host what the caret is currently inside, for its formatting UI. */
function reportSelection(editor: Editor): void {
  const { $from, empty } = editor.state.selection;
  send("selectionChanged", {
    isEmpty: empty,
    // Drives the native toolbar's active states.
    marks: Object.keys(editor.schema.marks).filter((mark) => editor.isActive(mark)),
    nodeType: $from.parent.type.name,
  });
}

let lastReportedHeight = 0;

function reportHeight(element: HTMLElement): void {
  const px = Math.ceil(element.getBoundingClientRect().height);
  // Sub-pixel jitter during typing would otherwise send a message per
  // keystroke for a height that has not meaningfully moved.
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
    // Reported rather than thrown: a throw here is swallowed by the JS
    // evaluation context and the host sees only a generic failure.
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
        // Three things at once, each load-bearing:
        //
        //   addToHistory: false  keeps the load out of the undo stack. Without
        //     it, undo on a freshly-opened page reverts to the empty document
        //     the editor started with. That is worse on a phone than a desktop:
        //     iOS offers shake-to-undo and an undo key on the keyboard, both
        //     easy to hit by accident.
        //   emitUpdate: false    stops the load being reported back as a change.
        //   applyingHostDocument also covers the transactions Tiptap runs while
        //     normalising, which emitUpdate alone does not.
        editor
          .chain()
          .setMeta("addToHistory", false)
          .setContent(JSON.parse(doc) as object, { emitUpdate: false })
          .run();
      } catch {
        // A document that will not parse is corrupt, not a reason to leave the
        // user staring at the previous page's content.
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
      // Tiptap flips `contenteditable` and drops the caret. No blur is sent
      // separately: a read-only surface that still owned the keyboard would
      // show a keyboard for a page that cannot take a keystroke.
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
        attrs: { "data-asset-path": assetPath },
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

/**
 * Marks the host may toggle.
 *
 * An allowlist rather than passing the name straight through: the message
 * carries a string from outside the webview, and `chain()[name]()` on an
 * arbitrary string is a call into whatever the editor happens to expose.
 */
const TOGGLEABLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);

function toggleMark(editor: Editor, mark: string): void {
  if (!TOGGLEABLE_MARKS.has(mark)) {
    // eslint-disable-next-line no-console
    console.warn("[pikos-bridge] unknown mark:", mark);
    return;
  }
  // focus() first, or the toggle applies to a selection the editor no longer
  // considers current — the native toolbar takes focus when tapped.
  editor.chain().focus().toggleMark(mark).run();
}

function toggleBlock(editor: Editor, nodeType: string, headingLevel: number): void {
  const chain = editor.chain().focus();
  switch (nodeType) {
    case "paragraph":
      chain.setParagraph().run();
      return;
    case "heading": {
      // The schema declares levels 1–3; anything else would be dropped on the
      // next parse, which reads to the user as the heading not sticking.
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

  // The host calls this through evaluateJavaScript. Exposed as a single
  // function rather than several so there is one place to version and one
  // place to validate.
  window.pikosEditor = {
    receive: (raw: unknown) => handleHostMessage(editor, raw),
  };

  send("ready", { protocolVersion: PROTOCOL_VERSION });

  if (!hasHost()) {
    // Standalone in a browser — give it something to type into so the editor
    // can be exercised without building the app.
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
