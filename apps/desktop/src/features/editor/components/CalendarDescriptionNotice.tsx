import { CalendarSync } from "lucide-react";
import { useState } from "react";

interface CalendarDescriptionNoticeProps {
  text: string;
}

/**
 * Shown when the event's description changed upstream but the user had already
 * edited the body — the reconciler parks the change (`page_sync.pending_description`)
 * rather than clobber it. Renders the parked text as-is; folding it in is manual
 * and one-way.
 */
export function CalendarDescriptionNotice({ text }: CalendarDescriptionNoticeProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-10 rounded-md bg-sky-500/10 px-3 py-2 text-sky-700/90 dark:text-sky-300/90">
      <div className="flex items-center gap-2">
        <CalendarSync aria-hidden="true" className="shrink-0" size={14} />
        <span className="type-ui-sm flex-1">The calendar description changed.</span>
        <button
          aria-expanded={open}
          className="type-ui-sm rounded underline-offset-2 hover:underline focus:outline-none"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "View"}
        </button>
      </div>
      {open && (
        <p className="type-ui-sm mt-2 border-t border-sky-500/20 pt-2 whitespace-pre-wrap text-subtle">
          {text}
        </p>
      )}
    </div>
  );
}
