// EditorPane — Tiptap WYSIWYG editor. Reuses a single ProseMirror instance
// across page switches (setContent instead of destroy/recreate) for instant switching.
// MetadataHeader (title, subtitle, status/priority/date/tags) sits above this component.

import { extractText } from "@pikos/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";

import { EmptyState } from "@/shared/components/EmptyState";
import type { LineWidth } from "@/shared/context/EditorSettingsContext";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { TabIndent } from "../extensions/TabIndent";
import { WebKitInputRuleFix } from "../extensions/WebKitInputRuleFix";
import { useAutosave } from "../hooks/useAutosave";
import { useEditorPage } from "../hooks/useEditorPage";
import { FindContentPopover } from "./FindContentPopover";
import { FormatToolbar } from "./FormatToolbar";
import { LinkPopover } from "./LinkPopover";
import { MetadataHeader } from "./MetadataHeader";
import { PageInfoPopover } from "./PageInfoPopover";
import { SlashMenuExtension } from "./SlashMenu";

// ─── Extensions ────────────────────────────────────────────────────────────────

const extensions = [
  StarterKit.configure({
    codeBlock: { HTMLAttributes: { class: "editor-code-block" } },
    heading: { levels: [1, 2, 3] },
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
  Underline,
  Markdown.configure({
    transformCopiedText: false,
    transformPastedText: true,
  }),
  SlashMenuExtension,
  TabIndent,
  WebKitInputRuleFix,
];

// HTML attributes applied to the ProseMirror contenteditable element.
const EDITOR_ATTRIBUTES = {
  "aria-label": "Page content",
  "aria-multiline": "true",
  "aria-placeholder": "Start writing, or press / for commands",
  autocapitalize: "off",
  autocomplete: "off",
  autocorrect: "off",
  class: "editor-content",
  role: "textbox",
};

const LINE_WIDTH_CLASS: Record<LineWidth, string> = {
  default: "max-w-[720px]",
  full: "max-w-none",
  narrow: "max-w-[560px]",
  wide: "max-w-[880px]",
};

// ─── EditorPane ────────────────────────────────────────────────────────────────

export function EditorPane() {
  const { isLoading, page } = useEditorPage();
  const { updatePage } = useWorkspace();
  const { lineWidth } = useEditorSettings();
  const { clearSelection, selectedPageIds } = useUI();

  // Track which page the editor currently shows (to detect page switches)
  const currentPageIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Content stored in a ref (not state) to avoid triggering React re-renders
  // on every keystroke. A version counter drives the autosave schedule.
  const contentJsonRef = useRef<string>("");
  const [contentVersion, setContentVersion] = useState(0);

  const editor = useEditor({
    editorProps: {
      attributes: EDITOR_ATTRIBUTES,
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

  // ─── Prevent native <a> navigation inside editor ───────────────────────────
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

  // ─── Page switch: load content into existing editor instance ──────────────
  // All mutations here are refs or external system calls (Tiptap) — no setState.

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

    // Only set content when the page actually changes
    if (page.id === currentPageIdRef.current) return;

    // Flush pending content for the outgoing page before switching
    if (currentPageIdRef.current && contentJsonRef.current !== "") {
      const content = contentJsonRef.current;
      updatePage(currentPageIdRef.current, { content, contentText: extractText(content) });
    }

    currentPageIdRef.current = page.id;

    // Parse stored content — handle empty/invalid gracefully
    let doc: JSONContent | null = null;
    if (page.content && page.content !== "" && page.content !== "{}") {
      try {
        doc = JSON.parse(page.content) as JSONContent;
      } catch {
        // Corrupted content — start fresh
        doc = null;
      }
    }

    // setContent without emitting an update (avoids triggering autosave for loaded content)
    if (!editor.isDestroyed) {
      editor.commands.setContent(doc ?? { content: [{ type: "paragraph" }], type: "doc" }, {
        emitUpdate: false,
      });
    }
    contentJsonRef.current = doc ? page.content : "";

    // Scroll after content is rendered — rAF defers until after Tiptap's DOM update
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: 0 });
    });
  }, [editor, page, isLoading]);

  // ─── Autosave: debounce content → updatePage ─────────────────────────────

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

  // Flush on window blur (user Cmd+Tab away)
  useEffect(() => {
    function handleBlur() {
      void flush();
    }
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [flush]);

  // ─── Link popover state ───────────────────────────────────────────────────
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

  // ─── Empty state ─────────────────────────────────────────────────────────

  if (!page) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState message="Select a page to start editing">
          <p className="type-ui-sm mt-1 text-subtle">
            or press <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">⌘N</kbd>{" "}
            to create a new page
          </p>
        </EmptyState>
      </div>
    );
  }

  // ─── Editor ──────────────────────────────────────────────────────────────

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
      {editor && (
        <LinkPopover
          editor={editor}
          isAddingLink={isAddingLink}
          onAddingLinkChange={setIsAddingLink}
        />
      )}
      {/* Visually-hidden live region — announces save errors to screen readers */}
      <div aria-atomic="true" aria-live="assertive" className="sr-only">
        {saveError ? "Failed to save. Please try again." : isSaving ? "Saving…" : ""}
      </div>
      <div className="relative flex-1 overflow-y-auto" ref={scrollContainerRef}>
        {/* min-h-full fills the scroll container so clicks below the text focus the editor */}
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
