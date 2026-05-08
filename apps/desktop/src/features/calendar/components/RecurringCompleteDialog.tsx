// RecurringCompleteDialog — gap-resolution prompt for completing an overdue
// recurring page. Mounted once at the app level; subscribes to
// RecurringCompleteDialogContext.pending and renders three card-shaped
// actions when there's a missed-day gap. Each card is a single-click commit
// (no separate confirm button); Escape or clicking outside dismisses.

import { format } from "date-fns";
import { ChevronRight } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useRecurringCompleteDialog } from "@/shared/context/RecurringCompleteDialogContext";

function formatDateLabel(yyyymmdd: string): string {
  // YYYY-MM-DD → e.g. "Tue May 5". No comma between weekday and date so a
  // comma-separated list of these reads cleanly. Constructed at noon local
  // time to dodge the parseISO-treats-bare-date-as-UTC pitfall.
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return format(dt, "EEE MMM d");
}

function MissedDaysSummary({ dates }: { dates: string[] }) {
  if (dates.length <= 3) {
    return <>{dates.map(formatDateLabel).join(", ")}</>;
  }
  // Long lists: first two + "… and N more"
  const head = dates.slice(0, 2).map(formatDateLabel).join(", ");
  return (
    <>
      {head}, and {dates.length - 2} more
    </>
  );
}

interface ChoiceCardProps {
  title: string;
  helper: string;
  onClick: () => void;
}

function ChoiceCard({ helper, onClick, title }: ChoiceCardProps) {
  return (
    <button
      className="group flex items-start justify-between gap-3 rounded-md border border-border/60 bg-card px-3 py-2 text-left transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={onClick}
      type="button"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="type-body-sm font-medium text-foreground">{title}</span>
        <span className="type-ui-xs text-muted-foreground">{helper}</span>
      </span>
      <ChevronRight
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
      />
    </button>
  );
}

export function RecurringCompleteDialog() {
  const { cancel, confirm, pending } = useRecurringCompleteDialog();
  const open = pending !== null;
  const missedCount = pending?.missedDates.length ?? 0;
  const nextLabel = pending?.nextDateLabel ? formatDateLabel(pending.nextDateLabel) : null;
  // "Advance to next page" lands on the earliest missed date; the later ones
  // stay as virtuals. Plural-aware copy reads better.
  const remainingCount = Math.max(0, missedCount - 1);
  const nextPageHelper = nextLabel
    ? remainingCount === 0
      ? `${nextLabel} becomes the next one.`
      : `${nextLabel} becomes the next one. The other ${remainingCount} stay${
          remainingCount === 1 ? "s" : ""
        } on the calendar.`
    : "The earliest missed day becomes the next one.";

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-[420px]" showCloseButton={false}>
        <DialogTitle>Mark complete</DialogTitle>
        {pending ? (
          <DialogDescription className="type-ui-sm text-muted-foreground">
            You missed {missedCount} day{missedCount === 1 ? "" : "s"} —{" "}
            <MissedDaysSummary dates={pending.missedDates} />. What should happen?
          </DialogDescription>
        ) : null}

        <div className="flex flex-col gap-1.5 pt-1">
          <ChoiceCard
            helper="Today becomes the next one. The missed days disappear from the calendar."
            onClick={() => confirm("skip")}
            title="Advance to today"
          />
          <ChoiceCard
            helper={nextPageHelper}
            onClick={() => confirm("advance")}
            title="Advance to next page"
          />
        </div>

        <div className="flex justify-end">
          <button
            className="type-ui-xs rounded px-2 py-1 text-muted-foreground hover:text-foreground"
            onClick={cancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
