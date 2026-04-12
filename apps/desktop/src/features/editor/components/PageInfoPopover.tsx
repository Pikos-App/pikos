// PageInfoPopover — bottom-right floating button that shows word count,
// character count, reading time, and page metadata on hover/click.

import type { Page } from "@pikos/core";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { format, formatDistanceToNow } from "date-fns";
import { Info } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface PageInfoPopoverProps {
  editor: Editor;
  page: Page;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

const WORDS_PER_MINUTE = 238;

function readingTime(wordCount: number): string {
  const minutes = Math.ceil(wordCount / WORDS_PER_MINUTE);
  if (minutes < 1) return "< 1 min";
  return `${minutes} min`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return format(date, "MMM d, yyyy 'at' h:mm a");
}

function relativeDate(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export function PageInfoPopover({ editor, page }: PageInfoPopoverProps) {
  const stats = useEditorState({
    editor,
    selector: (ctx) => {
      const doc = ctx.editor.state.doc;
      const texts: string[] = [];
      let blockCount = 0;
      doc.descendants((node) => {
        if (node.isTextblock) {
          blockCount++;
          const t = node.textContent.trim();
          if (t) texts.push(t);
        }
        return true;
      });
      const joined = texts.join(" ");
      return {
        chars: joined.length,
        paragraphs: blockCount,
        words: countWords(joined),
      };
    },
  });
  const { chars, paragraphs, words } = stats;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Page info"
          className="sticky right-3 bottom-3 z-10 ml-auto flex w-fit items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-surface-secondary"
        >
          <Info className="size-3.5" />
          <span>
            {words.toLocaleString()} word{words !== 1 ? "s" : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3" side="top" sideOffset={4}>
        <div className="space-y-3">
          <div className="space-y-1.5 text-xs">
            <InfoRow label="Words" value={words.toLocaleString()} />
            <InfoRow label="Characters" value={chars.toLocaleString()} />
            <InfoRow label="Paragraphs" value={paragraphs.toLocaleString()} />
            <InfoRow label="Reading time" value={readingTime(words)} />
          </div>

          <div className="border-t border-border pt-3" />

          <div className="space-y-1.5 text-xs">
            <InfoRow label="Created" value={relativeDate(page.createdAt)} />
            <div className="text-right text-[10px] text-muted-foreground">
              {formatDate(page.createdAt)}
            </div>

            <InfoRow label="Updated" value={relativeDate(page.updatedAt)} />
            <div className="text-right text-[10px] text-muted-foreground">
              {formatDate(page.updatedAt)}
            </div>

            {page.completedAt && (
              <>
                <InfoRow label="Completed" value={relativeDate(page.completedAt)} />
                <div className="text-right text-[10px] text-muted-foreground">
                  {formatDate(page.completedAt)}
                </div>
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
