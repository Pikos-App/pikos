// The focus panel on the Data page.
//
// A running total is a number you read once and learn nothing from. What makes
// focus time worth showing is its shape over time, so the same 12 weeks the
// activity chart covers get a second row of bars — an empty stretch reads as
// plainly as a full one, which is the point.
//
// Hidden entirely until a first session exists: an all-zero chart on a feature
// the user has never opened is furniture, not information.

import type { WorkspaceUsageStats } from "@pikos/core";
import { Timer } from "lucide-react";

import { weekLabel } from "../utils/weekLabel";

const BAR_MAX_H = 44;

/** Whole units, matching the end-of-session toast — see `formatSessionLength`. */
function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-lg font-semibold tracking-tight tabular-nums">{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

export function FocusSummary({ stats }: { stats: WorkspaceUsageStats }) {
  if (stats.total_focus_sessions === 0) return null;

  const weeks = stats.weekly_activity;
  const busiest = Math.max(1, ...weeks.map((w) => w.focus_minutes));
  const typical = Math.round(stats.total_focus_minutes / stats.total_focus_sessions);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Timer className="h-3.5 w-3.5" />
        Focus
      </div>

      <div className="mb-4 flex items-baseline gap-6">
        <Figure label="Total" value={formatMinutes(stats.total_focus_minutes)} />
        <Figure label="Sessions" value={String(stats.total_focus_sessions)} />
        <Figure label="Typical session" value={formatMinutes(typical)} />
      </div>

      {weeks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-end gap-1" style={{ height: BAR_MAX_H }}>
            {weeks.map((w, i) => (
              <div
                className="flex flex-1 items-end justify-center"
                key={w.week}
                style={{ height: BAR_MAX_H }}
              >
                {/* A week with any focus at all keeps a visible stub, so a short
                    week reads as "some" rather than rounding away to "none". */}
                <div
                  aria-hidden="true"
                  className="w-full max-w-[10px] rounded-t-sm bg-amber-500/60 transition-colors hover:bg-amber-500"
                  style={{
                    height:
                      w.focus_minutes > 0
                        ? Math.max(2, (w.focus_minutes / busiest) * BAR_MAX_H)
                        : 0,
                  }}
                  title={`${weekLabel(weeks, i)}: ${formatMinutes(w.focus_minutes)}`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{weekLabel(weeks, 0)}</span>
            <span>{weekLabel(weeks, weeks.length - 1)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
