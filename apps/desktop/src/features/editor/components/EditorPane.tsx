// EditorPane — Tiptap WYSIWYG editor. Reuses a single ProseMirror instance
// across page switches (setContent instead of destroy/recreate) for instant switching.

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
import { extractText } from "@pikos/core";
import type { Page } from "@pikos/core";
import { useAutosave } from "../hooks/useAutosave";
import { useEditorPage } from "../hooks/useEditorPage";
import type { JSONContent } from "@tiptap/react";

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
];

// ─── TitleSubtitleFields ───────────────────────────────────────────────────────
// Rendered above the editor. Uses key={page.id} in parent so state resets on
// page switch; useAutosave flushes on unmount (covers page switch + app close).

interface TitleSubtitleFieldsProps {
  page: Page;
  onFocusEditor: () => void;
}

function TitleSubtitleFields({ page, onFocusEditor }: TitleSubtitleFieldsProps) {
  const { updatePage } = useWorkspace();
  const titleRef = useRef<HTMLInputElement>(null);
  const subtitleRef = useRef<HTMLTextAreaElement>(null);

  const [titleValue, setTitleValue] = useState(page.title ?? "");
  const [subtitleValue, setSubtitleValue] = useState(page.subtitle ?? "");

  // Track last external values to detect changes from outside (e.g. page list rename).
  // "Derive during render" pattern — avoids useEffect → setState cascades.
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevExternalTitle, setPrevExternalTitle] = useState(page.title ?? "");
  const [prevExternalSubtitle, setPrevExternalSubtitle] = useState(page.subtitle ?? "");

  if ((page.title ?? "") !== prevExternalTitle) {
    setPrevExternalTitle(page.title ?? "");
    setTitleValue(page.title ?? "");
  }
  if ((page.subtitle ?? "") !== prevExternalSubtitle) {
    setPrevExternalSubtitle(page.subtitle ?? "");
    setSubtitleValue(page.subtitle ?? "");
  }

  // Title autosave (500ms debounce)
  const { flush: flushTitle } = useAutosave(
    titleValue,
    (val) => {
      updatePage(page.id, { title: val });
      return Promise.resolve();
    },
    { delay: 500 }
  );

  // Subtitle autosave (500ms debounce)
  const { flush: flushSubtitle } = useAutosave(
    subtitleValue,
    (val) => {
      updatePage(page.id, { subtitle: val });
      return Promise.resolve();
    },
    { delay: 500 }
  );

  // Flush both on window blur (user Cmd+Tab away)
  useEffect(() => {
    function handleBlur() {
      void flushTitle();
      void flushSubtitle();
    }
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [flushTitle, flushSubtitle]);

  // Focus an input/textarea and place cursor at end.
  // setSelectionRange is deferred so it runs after the browser's default focus behaviour.
  function focusAtEnd(el: HTMLInputElement | HTMLTextAreaElement | null) {
    if (!el) return;
    el.focus();
    requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
  }

  // Auto-resize subtitle textarea to fit content
  function adjustSubtitleHeight() {
    const el = subtitleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  useEffect(() => {
    adjustSubtitleHeight();
  });

  return (
    <div className="mb-4">
      <input
        ref={titleRef}
        type="text"
        value={titleValue}
        onChange={(e) => setTitleValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            focusAtEnd(subtitleRef.current);
          }
        }}
        onFocus={(e) => {
          const el = e.target;
          requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
        }}
        placeholder="Untitled"
        className="w-full bg-transparent text-3xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/30"
      />
      <textarea
        ref={subtitleRef}
        value={subtitleValue}
        onChange={(e) => {
          setSubtitleValue(e.target.value);
        }}
        onFocus={(e) => {
          const el = e.target;
          requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onFocusEditor();
          }
          if (e.key === "Backspace" && subtitleValue === "") {
            e.preventDefault();
            focusAtEnd(titleRef.current);
          }
        }}
        placeholder="Add a description…"
        rows={1}
        className="mt-1 w-full resize-none overflow-hidden bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/30"
      />
    </div>
  );
}

// ─── EditorPane ────────────────────────────────────────────────────────────────

export function EditorPane() {
  const { page, isLoading } = useEditorPage();
  const { updatePage } = useWorkspace();

  // Track which page the editor currently shows (to detect page switches)
  const currentPageIdRef = useRef<string | null>(null);

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
  });

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
  }, [editor, page, isLoading]);

  // ─── Autosave: debounce content → updatePage ─────────────────────────────

  const pageId = page?.id ?? null;

  const { isDirty, isSaving, saveError, flush } = useAutosave(
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

  // Expose save state for the save indicator (MetadataHeader will consume this via context later)
  const saveState = saveError ? "error" : isSaving ? "saving" : isDirty ? "dirty" : "clean";

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
    <div className="flex flex-1 flex-col overflow-hidden" data-save-state={saveState}>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-6">
          {page && (
            <TitleSubtitleFields
              key={page.id}
              page={page}
              onFocusEditor={() => editor?.commands.focus()}
            />
          )}
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
