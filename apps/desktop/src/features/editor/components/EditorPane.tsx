// EditorPane — Tiptap WYSIWYG editor. Reuses a single ProseMirror instance
// across page switches (setContent instead of destroy/recreate) for instant switching.
// MetadataHeader (title, subtitle, status/priority/date/tags) sits above this component.

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "tiptap-markdown";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { Keyboard } from "@/shared/keyboard/registry";
import { extractText } from "@pikos/core";
import { useAutosave } from "../hooks/useAutosave";
import { useEditorPage } from "../hooks/useEditorPage";
import { MetadataHeader } from "./MetadataHeader";
import type { JSONContent } from "@tiptap/react";
import { SlashMenuExtension } from "./SlashMenu";
import { LinkPopover } from "./LinkPopover";
import { TabIndent } from "../extensions/TabIndent";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

// ─── Extensions ────────────────────────────────────────────────────────────────

const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    codeBlock: { HTMLAttributes: { class: "editor-code-block" } },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({
    placeholder: "Start writing, or type '/' for commands…",
    showOnlyWhenEditable: true,
  }),
  Typography,
  Link.configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    HTMLAttributes: { class: "editor-link" },
  }),
  Underline,
  Markdown.configure({
    transformPastedText: true,
    transformCopiedText: false,
  }),
  SlashMenuExtension,
  TabIndent,
];

// ─── EditorPane ────────────────────────────────────────────────────────────────

export function EditorPane() {
  const { page, isLoading } = useEditorPage();
  const { updatePage } = useWorkspace();

  // Track which page the editor currently shows (to detect page switches)
  const currentPageIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Content stored in a ref (not state) to avoid triggering React re-renders
  // on every keystroke. A version counter drives the autosave schedule.
  const contentJsonRef = useRef<string>("");
  const [contentVersion, setContentVersion] = useState(0);

  const editor = useEditor({
    extensions,
    editorProps: {
      attributes: {
        class: "editor-content",
      },
    },
    onUpdate: ({ editor: e }) => {
      contentJsonRef.current = JSON.stringify(e.getJSON());
      setContentVersion((v) => v + 1);
    },
    onFocus: () => Keyboard.pushScope("editor"),
    onBlur: () => Keyboard.popScope("editor"),
  });

  // ─── Prevent native <a> navigation inside editor ───────────────────────────
  // Links are rendered as <a> by Tiptap but clicking should only place the cursor
  // (the LinkPopover handles opening links explicitly via its Open button).
  useEffect(() => {
    if (!editor) return;
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
    if (!editor || isLoading) return;

    if (page === null) {
      currentPageIdRef.current = null;
      editor.commands.clearContent();
      contentJsonRef.current = "";
      return;
    }

    // Only set content when the page actually changes
    if (page.id === currentPageIdRef.current) return;

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
    editor.commands.setContent(doc ?? { type: "doc", content: [{ type: "paragraph" }] }, {
      emitUpdate: false,
    });
    contentJsonRef.current = doc ? page.content : "";

    // Scroll after content is rendered — rAF defers until after Tiptap's DOM update
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: 0 });
    });
  }, [editor, page, isLoading]);

  // ─── Autosave: debounce content → updatePage ─────────────────────────────

  const pageId = page?.id ?? null;

  const { saveError, flush } = useAutosave(
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
    "Mod+K",
    () => {
      if (!editor) return;
      setIsAddingLink(true);
    },
    { scope: "editor", allowInInputs: true }
  );

  // ─── Empty state ─────────────────────────────────────────────────────────

  if (!page && !isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">Select a page to start editing</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            or press <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">⌘N</kbd>{" "}
            to create a new page
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-xs">Loading…</p>
      </div>
    );
  }

  // ─── Editor ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {page && (
        <MetadataHeader
          key={page.id}
          page={page}
          onFocusEditor={() => editor?.commands.focus()}
          contentSaveError={saveError}
          onRetryContent={() => void flush()}
        />
      )}
      {editor && (
        <LinkPopover
          editor={editor}
          isAddingLink={isAddingLink}
          onAddingLinkChange={setIsAddingLink}
        />
      )}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {/* min-h-full fills the scroll container so clicks below the text focus the editor */}
        <div
          className="mx-auto min-h-full w-full max-w-[720px] cursor-text px-8 pt-3 pb-8"
          onClick={(e) => {
            if (e.target === e.currentTarget) editor?.commands.focus("end");
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
