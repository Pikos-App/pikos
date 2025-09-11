<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView, keymap } from "@codemirror/view";
  import type { KeyBinding } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import type { Extension } from "@codemirror/state";
  import { markdown } from "@codemirror/lang-markdown";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
  import { Tag, tags } from "@lezer/highlight";

  export let content: string = "";
  export let onContentChange: (content: string) => void;

  let editorView: EditorView;
  let editorNode: HTMLElement;

  // Basic markdown keybindings
  const markdownKeymap: KeyBinding[] = [
    {
      key: "Mod-b",
      run: ({ state, dispatch }) => {
        if (!state.selection.main.empty) {
          const changes = {
            from: state.selection.main.from,
            to: state.selection.main.to,
            insert: `**${state.sliceDoc(state.selection.main.from, state.selection.main.to)}**`,
          };
          dispatch(state.update({ changes }));
          return true;
        }
        return false;
      },
    },
    {
      key: "Mod-i",
      run: ({ state, dispatch }) => {
        if (!state.selection.main.empty) {
          const changes = {
            from: state.selection.main.from,
            to: state.selection.main.to,
            insert: `_${state.sliceDoc(state.selection.main.from, state.selection.main.to)}_`,
          };
          dispatch(state.update({ changes }));
          return true;
        }
        return false;
      },
    },
    ...defaultKeymap,
    ...historyKeymap,
  ];

  onMount(() => {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const newContent = update.state.doc.toString();
        if (newContent !== content) {
          onContentChange?.(newContent);
        }
      }
    });

    const markdownStyles: { tag: Tag; class?: string }[] = [
      { tag: tags.heading1, class: "cm-header-1" },
      { tag: tags.heading2, class: "cm-header-2" },
      { tag: tags.heading3, class: "cm-header-3" },
      { tag: tags.heading4, class: "cm-header-4" },
      { tag: tags.strong, class: "cm-strong" },
      { tag: tags.emphasis, class: "cm-emphasis" },
      { tag: tags.strikethrough, class: "cm-strikethrough" },
      { tag: tags.monospace, class: "cm-monospace" },
      { tag: tags.link, class: "cm-link" },
      { tag: tags.quote, class: "cm-quote" },
      { tag: tags.list, class: "cm-list" },
    ];

    const markdownHighlighting = HighlightStyle.define(markdownStyles);

    const baseTheme = EditorView.theme({
      "&.cm-editor": {
        height: "100%",
        lineHeight: "1.6",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-content": {
        padding: "1rem",
      },
      ".cm-line": {
        padding: "2px 0",
      },
    });

    const markdownTheme = EditorView.theme({
      ".cm-header-1": {
        fontSize: "2em",
        fontWeight: "bold",
        lineHeight: "1.2",
        margin: "1.5em 0 0.5em 0",
      },
      ".cm-header-2": {
        fontSize: "1.5em",
        fontWeight: "bold",
        lineHeight: "1.3",
        margin: "1.5em 0 0.5em 0",
      },
      ".cm-header-3": {
        fontSize: "1.25em",
        fontWeight: "bold",
        margin: "1.5em 0 0.5em 0",
      },
      ".cm-header-4": {
        fontSize: "1.1em",
        fontWeight: "bold",
        margin: "1.25em 0 0.5em 0",
      },
      ".cm-strong": {
        fontWeight: "bold",
      },
      ".cm-emphasis": {
        fontStyle: "italic",
      },
      ".cm-strikethrough": {
        textDecoration: "line-through",
      },
      ".cm-monospace": {
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        backgroundColor: "rgba(135, 131, 120, 0.15)",
        borderRadius: "3px",
        padding: "0.2em 0.4em",
        fontSize: "0.9em",
      },
      ".cm-link": {
        color: "#0969da",
        textDecoration: "none",
        "&:hover": {
          textDecoration: "underline",
        },
      },
      ".cm-quote": {
        borderLeft: "4px solid #dfe2e5",
        padding: "0 1em",
        color: "#57606a",
        fontStyle: "normal",
        margin: "1em 0",
      },
      ".cm-list": {
        paddingLeft: "1.5em",
        margin: "0.5em 0",
      },
    });

    const extensions: Extension[] = [
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(markdownHighlighting),
      history(),
      keymap.of(markdownKeymap),
      updateListener,
      baseTheme,
      markdownTheme,
    ];

    editorView = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions,
      }),
      parent: editorNode,
    });

    return () => {
      editorView?.destroy();
    };
  });

  $: if (editorView && content !== editorView.state.doc.toString()) {
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: content },
    });
  }

  onDestroy(() => {
    editorView?.destroy();
  });
</script>

<div class="h-full overflow-hidden" bind:this={editorNode}></div>
