import { format } from "date-fns";
import { ChevronRight } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useRecurringGapDialog } from "@/shared/context/RecurringGapDialogContext";

/** "Tue May 5" form of a YYYY-MM-DD, built at noon local so parseISO cannot read a bare date as UTC. */
function formatDateLabel(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return format(dt, "EEE MMM d");
}

function MissedDaysSummary({ dates }: { dates: string[] }) {
  if (dates.length <= 3) {
    return <>{dates.map(formatDateLabel).join(", ")}</>;
  }
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

/** Scope prompt for a recurring gesture that lands on a backlog. Escape or an outside click dismisses. */
export function RecurringGapDialog() {
  const { cancel, confirm, pending } = useRecurringGapDialog();
  const open = pending !== null;
  const others = pending?.missedDates.length ?? 0;
  const isDelete = pending?.kind === "delete";
  // The title names the page and the day the gesture acts on (a native series' head, not the day
  // clicked); the body lists every day the bulk option acts on, so the count is checkable.
  const name = pending ? `“${pending.pageTitle}”` : "";
  const day = pending ? formatDateLabel(pending.occurrenceDate) : "";
  const allDates = pending ? [pending.occurrenceDate, ...pending.missedDates].sort() : [];
  const title = isDelete
    ? pending?.syncedActive
      ? `Remove ${name} on ${day} from Pikos?`
      : `Delete ${name} on ${day}?`
    : `Mark ${name} done for ${day}?`;
  const othersStay =
    others === 1 ? "The other day stays open." : `The other ${others} days stay open.`;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-[420px]" showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
        {pending ? (
          <DialogDescription className="type-ui-sm text-muted-foreground">
            {allDates.length} days before today are still open:{" "}
            <MissedDaysSummary dates={allDates} />.
          </DialogDescription>
        ) : null}

        <div className="flex flex-col gap-1.5 pt-1">
          <ChoiceCard
            helper={isDelete ? `Deletes ${day}. ${othersStay}` : `Marks ${day} done. ${othersStay}`}
            onClick={() => confirm("one")}
            title="Just this one"
          />
          <ChoiceCard
            helper={
              isDelete
                ? `Deletes all ${allDates.length} days.`
                : `Marks all ${allDates.length} days done.`
            }
            onClick={() => confirm("all")}
            title="This and everything before today"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          {isDelete && pending?.syncedActive ? (
            <p className="type-ui-xs text-subtle">
              Removes the local copy. Your calendar isn't touched.
            </p>
          ) : (
            <span />
          )}
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
