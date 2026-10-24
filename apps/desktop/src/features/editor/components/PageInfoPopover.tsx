import type { Page } from "@pikos/core";
import type { Editor } from "@tiptap/react";
import { format, formatDistanceToNow } from "date-fns";
import { Info } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { useIdleWordCount } from "../hooks/useIdleWordCount";
import { type PageStats, pageStats, readingTime } from "../utils/pageStats";

interface PageInfoPopoverProps {
  editor: Editor;
  page: Page;
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
  const words = useIdleWordCount(editor);
  const [stats, setStats] = useState<PageStats | null>(null);

  function handleOpenChange(isOpen: boolean): void {
    setStats(isOpen ? pageStats(editor.state.doc) : null);
  }

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          aria-label="Page info"
          className="flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-surface-secondary"
        >
          <Info className="size-3.5" />
          <span>
            {words.toLocaleString()} word{words !== 1 ? "s" : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3" side="top" sideOffset={4}>
        <div className="space-y-3">
          {stats && (
            <div className="space-y-1.5 text-xs">
              <InfoRow label="Words" value={stats.words.toLocaleString()} />
              <InfoRow label="Characters" value={stats.chars.toLocaleString()} />
              <InfoRow label="Paragraphs" value={stats.paragraphs.toLocaleString()} />
              <InfoRow label="Reading time" value={readingTime(stats.words)} />
            </div>
          )}

          <div className="border-t border-border pt-3" />

          <div className="space-y-1.5 text-xs">
            <InfoRow label="Created" value={relativeDate(page.createdAt)} />
            <div className="text-right text-3xs text-muted-foreground">
              {formatDate(page.createdAt)}
            </div>

            <InfoRow label="Updated" value={relativeDate(page.updatedAt)} />
            <div className="text-right text-3xs text-muted-foreground">
              {formatDate(page.updatedAt)}
            </div>

            {page.completedAt && (
              <>
                <InfoRow label="Completed" value={relativeDate(page.completedAt)} />
                <div className="text-right text-3xs text-muted-foreground">
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
