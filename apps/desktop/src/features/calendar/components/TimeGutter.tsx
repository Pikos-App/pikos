import { ChevronDown, ChevronsDownUp, ChevronUp } from "lucide-react";
import { useCallback } from "react";

import { cn } from "@/lib/utils";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";

import {
  clampBottomHour,
  clampTopHour,
  GRID_END_HOUR,
  GRID_START_HOUR,
  mapHourToY,
} from "../utils/calendarUtils";

function hourLabel(hour: number): string {
  const h = hour % 24;
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

export function TimeGutter() {
  const {
    collapse,
    geometry,
    metrics,
    setBottomCollapsed,
    setBottomHour,
    setTopCollapsed,
    setTopHour,
  } = useCalendarSettings();

  // Hour labels for the visible (non-collapsed) middle region. When a band is
  // expanded its hours are labelled the same way — there's no special "this
  // hour is in the band" treatment, just an extra collapse chevron and drag
  // handle at the boundary.
  const labelStart = collapse.topCollapsed ? collapse.topHour : GRID_START_HOUR;
  const labelEnd = collapse.bottomCollapsed ? collapse.bottomHour : GRID_END_HOUR;
  const middleHours: number[] = [];
  for (let h = labelStart; h <= labelEnd; h++) middleHours.push(h);

  // Drag-to-adjust the X (top) or Y (bottom) boundary. Live-updates the saved
  // hour as the cursor moves; commits on release. Snaps to whole hours so the
  // boundary always lands on a label line.
  const startBoundaryDrag = useCallback(
    (which: "top" | "bottom", clientYStart: number) => {
      const hourHeight = metrics.hourHeight;
      const startHour = which === "top" ? collapse.topHour : collapse.bottomHour;
      function onMove(ev: MouseEvent) {
        const deltaPx = ev.clientY - clientYStart;
        const deltaHours = Math.round(deltaPx / hourHeight);
        if (which === "top") {
          const next = clampTopHour(startHour + deltaHours, collapse.bottomHour);
          if (next !== collapse.topHour) setTopHour(next);
        } else {
          const next = clampBottomHour(startHour + deltaHours, collapse.topHour);
          if (next !== collapse.bottomHour) setBottomHour(next);
        }
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.documentElement.classList.remove("dragging-resize");
      }
      document.documentElement.classList.add("dragging-resize");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [collapse.bottomHour, collapse.topHour, metrics.hourHeight, setBottomHour, setTopHour]
  );

  return (
    <div className="relative w-14 shrink-0 select-none" style={{ height: geometry.totalHeight }}>
      {/* ── Top region ─────────────────────────────────────────────────── */}
      {collapse.topCollapsed ? (
        // Compressed band: two endpoint labels + chevron between, click to expand.
        <button
          aria-label={`Expand ${hourLabel(0)} to ${hourLabel(collapse.topHour)}`}
          className={cn(
            "absolute inset-x-0 top-0 flex flex-col items-center justify-between",
            "py-1 text-foreground/70 hover:bg-foreground/[0.04]"
          )}
          onClick={() => setTopCollapsed(false)}
          style={{ height: geometry.topBandHeight }}
          type="button"
        >
          <span className="type-ui-sm">{hourLabel(0)}</span>
          <ChevronsDownUp aria-hidden className="h-3 w-3 text-subtle" strokeWidth={1.5} />
          <span className="type-ui-sm">{hourLabel(collapse.topHour)}</span>
        </button>
      ) : (
        // Expanded: collapse-up chevron at the very top, hour labels for [0, topHour].
        <>
          <button
            aria-label={`Collapse ${hourLabel(0)} to ${hourLabel(collapse.topHour)}`}
            className={cn(
              "absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-sm",
              "text-subtle hover:bg-foreground/[0.06] hover:text-foreground"
            )}
            onClick={() => setTopCollapsed(true)}
            type="button"
          >
            <ChevronUp aria-hidden className="h-3 w-3" strokeWidth={1.5} />
          </button>
        </>
      )}

      {/* ── Middle hour labels — same placement rule for both states ─── */}
      {middleHours.map((hour) => {
        const y = mapHourToY(hour, geometry);
        // 12 AM at top of grid pins below the edge so it stays visible; every
        // other label sits above its hour line (-mt-2). When the top band is
        // collapsed, the first middle label IS the topHour boundary — keep
        // it pinned just below the band edge (mt-1) so it doesn't overlap
        // with the band's "Xam" label.
        const isTopOfGrid = hour === GRID_START_HOUR;
        const isFirstAfterCollapsed = collapse.topCollapsed && hour === collapse.topHour;
        // The bottomHour label, when the bottom is collapsed, is rendered by
        // the bottom band itself — skip it here to avoid duplicates.
        if (collapse.bottomCollapsed && hour === collapse.bottomHour) return null;
        // The topHour label, when the top is collapsed, is rendered by the
        // top band — skip the duplicate here.
        if (collapse.topCollapsed && hour === collapse.topHour) return null;
        return (
          <div
            className="absolute inset-x-0 flex items-start justify-end pr-2"
            key={hour}
            style={{ height: metrics.hourHeight, top: y }}
          >
            <span
              className={cn(
                "type-ui-sm text-subtle",
                isTopOfGrid || isFirstAfterCollapsed ? "mt-1" : "-mt-2"
              )}
            >
              {hourLabel(hour)}
            </span>
          </div>
        );
      })}

      {/* ── Boundary drag handles (only visible when the corresponding
            band is expanded) — let the user adjust X or Y by dragging. */}
      {!collapse.topCollapsed && (
        <div
          aria-label="Adjust top collapse boundary"
          className={cn(
            "absolute inset-x-0 z-10 cursor-ns-resize",
            "before:absolute before:inset-x-1 before:top-1/2 before:h-px",
            "before:-translate-y-1/2 before:bg-foreground/30 hover:before:bg-foreground/60"
          )}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            startBoundaryDrag("top", e.clientY);
          }}
          role="separator"
          style={{
            height: 6,
            top: mapHourToY(collapse.topHour, geometry) - 3,
          }}
          tabIndex={-1}
        />
      )}
      {!collapse.bottomCollapsed && (
        <div
          aria-label="Adjust bottom collapse boundary"
          className={cn(
            "absolute inset-x-0 z-10 cursor-ns-resize",
            "before:absolute before:inset-x-1 before:top-1/2 before:h-px",
            "before:-translate-y-1/2 before:bg-foreground/30 hover:before:bg-foreground/60"
          )}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            startBoundaryDrag("bottom", e.clientY);
          }}
          role="separator"
          style={{
            height: 6,
            top: mapHourToY(collapse.bottomHour, geometry) - 3,
          }}
          tabIndex={-1}
        />
      )}

      {/* ── Bottom region ─────────────────────────────────────────────── */}
      {collapse.bottomCollapsed ? (
        <button
          aria-label={`Expand ${hourLabel(collapse.bottomHour)} to ${hourLabel(0)}`}
          className={cn(
            "absolute inset-x-0 flex flex-col items-center justify-between",
            "py-1 text-foreground/70 hover:bg-foreground/[0.04]"
          )}
          onClick={() => setBottomCollapsed(false)}
          style={{ height: geometry.bottomBandHeight, top: geometry.middleEnd }}
          type="button"
        >
          <span className="type-ui-sm">{hourLabel(collapse.bottomHour)}</span>
          <ChevronsDownUp aria-hidden className="h-3 w-3 text-subtle" strokeWidth={1.5} />
          <span className="type-ui-sm">{hourLabel(0)}</span>
        </button>
      ) : (
        <button
          aria-label={`Collapse ${hourLabel(collapse.bottomHour)} to ${hourLabel(0)}`}
          className={cn(
            "absolute right-0.5 flex h-4 w-4 items-center justify-center rounded-sm",
            "text-subtle hover:bg-foreground/[0.06] hover:text-foreground"
          )}
          onClick={() => setBottomCollapsed(true)}
          style={{ top: geometry.totalHeight - 18 }}
          type="button"
        >
          <ChevronDown aria-hidden className="h-3 w-3" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
