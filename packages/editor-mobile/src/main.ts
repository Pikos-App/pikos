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
    onSelectionUpdate: ({ editor: e }) => {
      const { $from, empty } = e.state.selection;
      send("selectionChanged", {
        isEmpty: empty,
        // Drives the native formatting toolbar's active states.
        marks: Object.keys(e.schema.marks).filter((mark) => e.isActive(mark)),
        nodeType: $from.parent.type.name,
      });
    },
    onUpdate: ({ editor: e }) => {
      // A host-initiated load fires onUpdate too. Sending that back would have
      // the host persist a document it just supplied — harmless in isolation,
      // but it makes every page open look like an edit in the change log.
      if (applyingHostDocument) return;
      sendDocChanged(e);
      reportHeight(element);
    },
  });

  // iOS can suspend the process shortly after backgrounding, which would take a
  // pending debounce — and the user's last keystrokes — with it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendDocChanged.flush();
  });
  window.addEventListener("pagehide", () => sendDocChanged.flush());

  return editor;
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
        // `emitUpdate: false` is belt to the `applyingHostDocument` braces —
        // the flag also covers the transactions Tiptap runs while normalising.
        editor.commands.setContent(JSON.parse(doc) as object, { emitUpdate: false });
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
