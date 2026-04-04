// WebKitInputRuleFix — works around a WebKit contenteditable rendering bug
// where typing "1." (or any input-rule trigger) as the very first content
// causes the text to vanish until the next keystroke.
//
// Root cause: when a ProseMirror input rule replaces a paragraph with an
// ordered-list node, WebKit sometimes fails to repaint the new DOM. Forcing
// a synchronous view update in a microtask after the transaction fixes it.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const pluginKey = new PluginKey("webkitInputRuleFix");

export const WebKitInputRuleFix = Extension.create({
  addProseMirrorPlugins() {
    const isWebKit = typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent);

    if (!isWebKit) return [];

    return [
      new Plugin({
        key: pluginKey,
        view(_editorView) {
          return {
            update(view, prevState) {
              // Detect when a transaction converted a paragraph into a list.
              // Input-rule transactions carry the `isInputRules` meta flag in
              // Tiptap ≥ 3 (set by @tiptap/core's inputRulesPlugin). When the
              // doc changed and involves a node-type swap, force a repaint.
              const { state } = view;
              if (state.doc.eq(prevState.doc)) return;

              // Only act when the top-level node structure changed (the
              // typical symptom is paragraph → orderedList / bulletList).
              const prevFirstChild = prevState.doc.firstChild;
              const curFirstChild = state.doc.firstChild;
              if (prevFirstChild && curFirstChild && prevFirstChild.type !== curFirstChild.type) {
                // Schedule a forced DOM sync after WebKit finishes its
                // current contenteditable mutation processing.
                queueMicrotask(() => {
                  view.updateState(view.state);
                });
              }
            },
          };
        },
      }),
    ];
  },

  name: "webkitInputRuleFix",
});
