// Reuses a single ProseMirror instance across page switches
// (setContent instead of destroy/recreate) for instant switching.

import { extractText } from "@pikos/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Typography from "@tiptap/extension-typography";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";

import { EmptyState } from "@/shared/components/EmptyState";
import { EDITOR_ATTRIBUTES, LINE_WIDTH_CLASS } from "@/shared/constants/editor";
import { MOD_KEY_LABEL } from "@/shared/constants/platform";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useSelection } from "@/shared/context/SelectionContext";
import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { EMPTY_TIPTAP_DOC, tryParseTiptapJson } from "@/shared/utils/jsonContent";

import { PikosImage } from "../extensions/PikosImage";
import { PikosTable } from "../extensions/PikosTable";
import { TabIndent } from "../extensions/TabIndent";
import { useAutosave } from "../hooks/useAutosave";
import { useEditorPage } from "../hooks/useEditorPage";
import { registerActiveEditor } from "../utils/imageDropBridge";
import { looksLikeMarkdown } from "../utils/markdownPaste";
import { FindContentPopover } from "./FindContentPopover";
import { FormatToolbar } from "./FormatToolbar";
import { LinkPopover } from "./LinkPopover";
import { MetadataHeader } from "./MetadataHeader";
import { PageInfoPopover } from "./PageInfoPopover";
import { SlashMenuExtension } from "./SlashMenu";
import { TableToolbar } from "./TableToolbar";

const extensions = [
  StarterKit.configure({
    codeBlock: { HTMLAttributes: { class: "editor-code-block" } },
    heading: { levels: [1, 2, 3] },
    link: false,
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({
    placeholder: "Start writing, or press / for commands",
    showOnlyWhenEditable: true,
  }),
  Typography,
  Link.configure({
    autolink: true,
    defaultProtocol: "https",
    HTMLAttributes: { class: "editor-link" },
    linkOnPaste: true,
    openOnClick: false,
  }),
  Markdown.configure({
    transformCopiedText: false,
    transformPastedText: true,
  }),
  PikosImage.configure({
    allowBase64: false,
    inline: false,
  }),
  PikosTable,
  SlashMenuExtension,
  TabIndent,
];

// tiptap-markdown only converts pasted markdown when the clipboard has no
// text/html, which is rarely the case (VS Code, browsers, ChatGPT all attach
// HTML). Intercept paste and force markdown conversion when the plain text
// looks like markdown — see utils/markdownPaste for the why.
function handleMarkdownPaste(editor: Editor | null, event: ClipboardEvent): boolean {
  if (!editor) return false;
  // Inside a code block, raw text is intended — leave it untouched.
  if (editor.state.selection.$from.parent.type.spec.code) return false;
  const text = event.clipboardData?.getData("text/plain");
  if (!text || !looksLikeMarkdown(text)) return false;
  // insertContent is overridden by tiptap-markdown to parse strings as markdown.
  return editor.commands.insertContent(text);
}

export function EditorPane() {
  const { isLoading, page } = useEditorPage();
  const { updatePage } = usePages();
  const { lineWidth } = useEditorSettings();
  const { clearSelection, selectedPageIds } = useSelection();

  const currentPageIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // The editor instance, captured for use inside editorProps callbacks (which
  // are created before useEditor returns). Assigned in an effect below.
  const editorRef = useRef<Editor | null>(null);

  // Content stored in a ref (not state) to avoid triggering React re-renders
  // on every keystroke. A version counter drives the autosave schedule.
  const contentJsonRef = useRef<string>("");
  const [contentVersion, setContentVersion] = useState(0);

  const editor = useEditor({
    editorProps: {
      attributes: EDITOR_ATTRIBUTES,
      handlePaste: (_view, event) => handleMarkdownPaste(editorRef.current, event),
    },
    extensions,
    onBlur: () => Keyboard.popScope("editor"),
    onFocus: () => {
      Keyboard.pushScope("editor");
      if (selectedPageIds.size > 0) clearSelection();
    },
    onUpdate: ({ editor: e }) => {
      contentJsonRef.current = JSON.stringify(e.getJSON());
      setContentVersion((v) => v + 1);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Links are rendered as <a> by Tiptap but clicking should only place the cursor
  // (the LinkPopover handles opening links explicitly via its Open button).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    function handleClick(e: Event) {
      const target = (e as MouseEvent).target as HTMLElement;
      if (target.closest("a")) {
        e.preventDefault();
      }
    }
    dom.addEventListener("click", handleClick);
    return () => dom.removeEventListener("click", handleClick);
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    return registerActiveEditor(editor);
  }, [editor]);

  // Page switch: all mutations here are refs or external system calls (Tiptap) — no setState.
  useEffect(() => {
    if (!editor || editor.isDestroyed || isLoading) return;

    if (page === null) {
      // Flush pending content for the outgoing page before clearing
      if (currentPageIdRef.current && contentJsonRef.current !== "") {
        const content = contentJsonRef.current;
        updatePage(currentPageIdRef.current, { content, contentText: extractText(content) });
      }
      currentPageIdRef.current = null;
      if (!editor.isDestroyed) editor.commands.clearContent();
      contentJsonRef.current = "";
      return;
    }

    if (page.id === currentPageIdRef.current) return;

    // Flush pending content for the outgoing page before switching
    if (currentPageIdRef.current && contentJsonRef.current !== "") {
      const content = contentJsonRef.current;
      updatePage(currentPageIdRef.current, { content, contentText: extractText(content) });
    }

    currentPageIdRef.current = page.id;

    const doc = tryParseTiptapJson(page.content, `EditorPane page=${page.id}`);

    // setContent without emitting an update (avoids triggering autosave for loaded content)
    if (!editor.isDestroyed) {
      editor.commands.setContent(doc ?? EMPTY_TIPTAP_DOC, { emitUpdate: false });
    }
    contentJsonRef.current = doc ? page.content : "";

    // Scroll after content is rendered — rAF defers until after Tiptap's DOM update
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: 0 });
    });
  }, [editor, page, isLoading]);

  const pageId = page?.id ?? null;

  const { flush, isSaving, saveError } = useAutosave(
    contentVersion,
    (_version: number) => {
      if (!pageId || contentJsonRef.current === "") return Promise.resolve();
      const contentText = extractText(contentJsonRef.current);
      updatePage(pageId, { content: contentJsonRef.current, contentText });
      return Promise.resolve();
    },
    { delay: 800 }
  );

  useEffect(() => {
    function handleBlur() {
      void flush();
    }
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [flush]);

  const [isAddingLink, setIsAddingLink] = useState(false);

  useKeyboardShortcut(
    "Mod+Shift+K",
    () => {
      if (!editor) return;
      editor.view.dom.blur();
      setIsAddingLink(true);
    },
    { allowInInputs: true, scope: "editor" }
  );

  if (!page) {
    // While a new active page is loading (debounce + getPage round-trip),
    // render a blank surface instead of the "Select a page" empty state.
    // Otherwise switching pages briefly flashes the empty state before the
    // new content arrives.
    if (isLoading) {
      return <div className="flex flex-1 flex-col bg-surface-primary" />;
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState message="Select a page to start editing">
          <p className="type-ui-sm mt-1 text-subtle">
            or press{" "}
            <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">
              {MOD_KEY_LABEL}N
            </kbd>{" "}
            to create a new page
          </p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="group/editor relative flex flex-1 flex-col overflow-hidden bg-surface-primary">
      {page && (
        <MetadataHeader
          contentSaveError={saveError}
          key={page.id}
          onFocusEditor={() => !editor?.isDestroyed && editor?.commands.focus()}
          onRetryContent={() => void flush()}
          page={page}
        />
      )}
      {editor && <FindContentPopover editor={editor} />}
      {editor && !isAddingLink && (
        <FormatToolbar editor={editor} onAddLink={() => setIsAddingLink(true)} />
      )}
      {editor && <TableToolbar editor={editor} />}
      {editor && (
        <LinkPopover
          editor={editor}
          isAddingLink={isAddingLink}
          onAddingLinkChange={setIsAddingLink}
        />
      )}
      <div aria-atomic="true" aria-live="assertive" className="sr-only">
        {saveError ? "Failed to save. Please try again." : isSaving ? "Saving…" : ""}
      </div>
      <div className="relative flex-1 overflow-y-auto" ref={scrollContainerRef}>
        {/* min-h-full fills the scroll container so clicks below the text focus the editor */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- padding around the editor; clicks delegate focus to the ProseMirror surface which is the real keyboard target */}
        <div
          className={`mx-auto min-h-full w-full ${LINE_WIDTH_CLASS[lineWidth]} cursor-text px-8 pt-3 pb-8`}
          onMouseDown={(e) => {
            // Only focus editor on direct clicks on the empty padding area,
            // not after drag-selections that end outside text bounds.
            if (e.target === e.currentTarget && !editor?.isFocused) {
              // Defer so the mousedown doesn't interfere with ProseMirror's own handling
              requestAnimationFrame(() => !editor?.isDestroyed && editor?.commands.focus("end"));
            }
          }}
        >
          <EditorContent editor={editor} />
        </div>
        {editor && <PageInfoPopover editor={editor} page={page} />}
      </div>
    </div>
  );
}
