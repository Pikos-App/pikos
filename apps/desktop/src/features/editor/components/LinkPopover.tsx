import { openUrl } from "@tauri-apps/plugin-opener";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Check, Copy, ExternalLink, Pencil, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { createLogger } from "@/shared/logger";

const log = createLogger("LinkPopover");

interface LinkPopoverProps {
  editor: Editor;
  isAddingLink: boolean;
  onAddingLinkChange: (adding: boolean) => void;
}

function getLinkMarkStart(editor: Editor): number | null {
  const { state } = editor;
  const { from } = state.selection;
  const linkMarkType = state.schema.marks["link"];
  if (!linkMarkType) return null;

  // The cursor may be at the end of the link (from-1 has the mark, from does not).
  const anchorPos = state.doc
    .resolve(from)
    .marks()
    .some((m) => m.type === linkMarkType)
    ? from
    : from - 1;

  if (anchorPos < 0) return null;

  // Walk left until the mark ends to find the mark's start position.
  let markStart = anchorPos;
  while (markStart > 0) {
    const marks = state.doc.resolve(markStart - 1).marks();
    if (!marks.some((m) => m.type === linkMarkType)) break;
    markStart--;
  }
  return markStart;
}

function getAnchorRect(editor: Editor, isLink: boolean): DOMRect | null {
  if (isLink) {
    // Use the mark's start position in the doc — stable at all cursor positions
    // including end-of-link boundaries where DOM lookups can misfire.
    const markStart = getLinkMarkStart(editor);
    if (markStart !== null) {
      const coords = editor.view.coordsAtPos(markStart);
      // coordsAtPos returns the glyph position; use bottom-left of that line
      return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
    }
  }
  const { from } = editor.state.selection;
  const coords = editor.view.coordsAtPos(from);
  return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
}

function computePopoverPos(
  isVisible: boolean,
  editor: Editor,
  isLink: boolean,
  _selectionFrom: number,
  _posVersion: number
): { top: number; left: number } | null {
  if (!isVisible) return null;
  const rect = getAnchorRect(editor, isLink);
  if (!rect) return null;
  const POPOVER_WIDTH = 320;
  const EDGE_PADDING = 8;
  let left = rect.left;
  if (left + POPOVER_WIDTH > window.innerWidth - EDGE_PADDING) {
    left = window.innerWidth - POPOVER_WIDTH - EDGE_PADDING;
  }
  if (left < EDGE_PADDING) left = EDGE_PADDING;
  return { left, top: rect.bottom + 6 };
}

function ensureProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function truncateUrl(url: string, max = 40): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + "\u2026";
}

export function LinkPopover({ editor, isAddingLink, onAddingLinkChange }: LinkPopoverProps) {
  const [editMode, setEditMode] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const { editorFocused, isLink, linkHref, selectionEmpty, selectionFrom } = useEditorState({
    editor,
    selector: (ctx) => {
      const { state } = ctx.editor;
      const { from } = state.selection;
      const linkMarkType = state.schema.marks["link"];

      // Check the document directly — not stored marks, not the DOM.
      // Stored marks persist on the cursor after deletion and would give a false positive.
      let hasLinkInDoc = false;
      let href = "";
      if (linkMarkType) {
        // Check only at `from` — checking from-1 would falsely show the popover
        // when the cursor is on a trailing space just after the link boundary.
        const positions = [from];
        for (const pos of positions) {
          const mark = state.doc
            .resolve(pos)
            .marks()
            .find((m) => m.type === linkMarkType);
          if (mark) {
            hasLinkInDoc = true;
            href = (mark.attrs["href"] as string) ?? "";
            break;
          }
        }
      }

      return {
        editorFocused: ctx.editor.isFocused,
        isLink: hasLinkInDoc,
        linkHref: href,
        selectionEmpty: state.selection.empty,
        selectionFrom: from,
      };
    },
  });

  const showViewMode = isLink && selectionEmpty && editorFocused && !editMode && !isAddingLink;
  const showEditMode = editMode || isAddingLink;
  const isVisible = showViewMode || showEditMode;

  const [prevIsAddingLink, setPrevIsAddingLink] = useState(false);
  if (isAddingLink && !prevIsAddingLink) {
    setPrevIsAddingLink(true);
    setEditMode(true);
    setUrlValue(isLink ? linkHref : "");
  } else if (!isAddingLink && prevIsAddingLink) {
    setPrevIsAddingLink(false);
  }

  useEffect(() => {
    if (editMode) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editMode]);

  function close() {
    setEditMode(false);
    setCopied(false);
    onAddingLinkChange(false);
  }

  // Close on click outside (but not on the toolbar — it has its own open/close flow)
  useEffect(() => {
    if (!isVisible) return;

    function handleMouseDown(e: MouseEvent) {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.("[data-format-toolbar]")) return;
      close();
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isVisible, editor, close]);

  useEffect(() => {
    if (!showEditMode) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        editor.commands.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [showEditMode, editor, close]);

  const handleApply = () => {
    const href = ensureProtocol(urlValue);
    if (!href) return;

    if (isLink) {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    } else {
      if (!editor.state.selection.empty) {
        editor.chain().focus().setLink({ href }).run();
      } else {
        editor.chain().focus().insertContent(`<a href="${href}">${href}</a>`).run();
      }
    }

    setEditMode(false);
    onAddingLinkChange(false);
  };

  const handleEdit = () => {
    setUrlValue(linkHref);
    setEditMode(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const handleUnlink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    close();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(linkHref);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      log.warn("clipboard write failed", err);
    }
  };

  const handleOpen = () => {
    void openUrl(linkHref);
  };

  // Position is derived during render from editor state. A version counter
  // triggers re-renders on scroll/resize so the position stays current.
  const [posVersion, setPosVersion] = useState(0);

  useEffect(() => {
    if (!isVisible) return;

    function bump() {
      setPosVersion((v) => v + 1);
    }

    const scrollContainer = editor.view.dom.closest(".overflow-y-auto");
    scrollContainer?.addEventListener("scroll", bump);
    window.addEventListener("resize", bump);
    return () => {
      scrollContainer?.removeEventListener("scroll", bump);
      window.removeEventListener("resize", bump);
    };
  }, [isVisible, editor]);

  // selectionFrom + posVersion are included as deps so the position
  // recalculates when the cursor moves or scrolls.
  const pos = computePopoverPos(isVisible, editor, isLink, selectionFrom, posVersion);

  // Suppress unused-read lint — posVersion is only used to trigger recalculation
  void posVersion;

  if (!isVisible || !pos) return null;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- preventDefault on mousedown is the standard pattern for preventing editor blur; popover content provides its own keyboard surface
    <div
      className="link-popover"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      ref={popoverRef}
      style={{ left: pos.left, top: pos.top }}
    >
      {showEditMode ? (
        <div className="flex items-center gap-1.5">
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="link-popover-input"
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleApply();
              }
            }}
            placeholder="Paste or type a URL…"
            ref={inputRef}
            spellCheck={false}
            type="url"
            value={urlValue}
          />
          <button
            className="link-popover-btn link-popover-btn-primary"
            onClick={handleApply}
            title="Apply"
          >
            <Check size={14} />
          </button>
          {isLink && (
            <button className="link-popover-btn" onClick={handleUnlink} title="Remove link">
              <Unlink size={14} />
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button className="link-popover-url" onClick={handleOpen} title={linkHref}>
            {truncateUrl(linkHref)}
          </button>
          <div className="link-popover-divider" />
          <button className="link-popover-btn" onClick={handleOpen} title="Open link">
            <ExternalLink size={13} />
          </button>
          <button className="link-popover-btn" onClick={() => void handleCopy()} title="Copy URL">
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button className="link-popover-btn" onClick={handleEdit} title="Edit link">
            <Pencil size={13} />
          </button>
          <button className="link-popover-btn" onClick={handleUnlink} title="Remove link">
            <Unlink size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
