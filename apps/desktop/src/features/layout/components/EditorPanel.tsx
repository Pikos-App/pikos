import { clampDayCount, dayCountNavStep, getCalendarDayCount } from "@pikos/core";
import { addDays, addMonths, startOfMonth, subDays, subMonths } from "date-fns";
import { Activity } from "react";

import { CalendarHeader, CalendarView } from "@/features/calendar";
import { EditorPane } from "@/features/editor";
import { useLayoutMode } from "@/features/layout/breakpoints";
import { PaneErrorFallback } from "@/shared/components/PaneErrorFallback";
import { useCalendarDate } from "@/shared/context/CalendarDateContext";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useLeftNavToggle } from "../hooks/useLeftNavToggle";
import { RightPanelHeader } from "./RightPanelHeader";

export function EditorPanel() {
  const ui = useUI();
  const { referenceDate, setReferenceDate } = useCalendarDate();
  // Must match CalendarView's effective day count — otherwise prev/next step by
  // the breakpoint max (7) while the view renders fewer days, skipping dates.
  const { dayCount: preferredDayCount, setViewMode, viewMode } = useCalendarSettings();
  const dayCount = clampDayCount(preferredDayCount, getCalendarDayCount(useLayoutMode()));
  const navStep = dayCountNavStep(dayCount);
  const isMonth = viewMode === "month";
  const leftNav = useLeftNavToggle();

  useKeyboardShortcut(
    "Mod+Shift+C",
    () => {
      ui.setRightPanel(ui.rightPanel === "editor" ? "calendar" : "editor");
    },
    { allowInInputs: true, group: "Navigation", label: "Toggle calendar / editor" }
  );

  useKeyboardShortcut("Mod+\\", leftNav.toggle, {
    allowInInputs: true,
    group: "Navigation",
    label: "Toggle sidebar",
  });

  // Month view steps a whole month at a time, anchored to the 1st so a long
  // month never skips a short one (Jan 31 → Mar 3 under plain month addition).
  function handlePrevWeek() {
    setReferenceDate(
      isMonth ? startOfMonth(subMonths(referenceDate, 1)) : subDays(referenceDate, navStep)
    );
  }

  function handleNextWeek() {
    setReferenceDate(
      isMonth ? startOfMonth(addMonths(referenceDate, 1)) : addDays(referenceDate, navStep)
    );
  }

  function handleToday() {
    setReferenceDate(new Date());
  }

  // Here rather than in the calendar header, which mounts only while the calendar
  // shows: the shortcuts page lists what has registered, and a Calendar section
  // missing until the calendar was first opened documented nothing.
  const calendarShown = () => ui.rightPanel === "calendar";
  const unit = isMonth ? "month" : "week";
  useKeyboardShortcut("ArrowLeft", handlePrevWeek, {
    group: "Calendar",
    label: `Previous ${unit}`,
    when: calendarShown,
  });
  useKeyboardShortcut("ArrowRight", handleNextWeek, {
    group: "Calendar",
    label: `Next ${unit}`,
    when: calendarShown,
  });
  useKeyboardShortcut("t", handleToday, {
    group: "Calendar",
    label: "Jump to today",
    when: calendarShown,
  });
  useKeyboardShortcut("m", () => setViewMode(isMonth ? "time" : "month"), {
    group: "Calendar",
    label: isMonth ? "Switch to time grid" : "Switch to month view",
    when: calendarShown,
  });

  // min-w-0: a flex item defaults to min-width:auto and so refuses to shrink
  // below its content. The month grid is as wide as its widest row wants to be,
  // so without this the panel grows past the window and drags the whole
  // three-panel shell with it — the sidebar and page list scroll off screen.
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <RightPanelHeader>
        {ui.rightPanel === "calendar" && (
          <CalendarHeader
            dayCount={dayCount}
            onNextWeek={handleNextWeek}
            onPrevWeek={handlePrevWeek}
            onToday={handleToday}
            onViewModeChange={setViewMode}
            referenceDate={referenceDate}
            viewMode={viewMode}
          />
        )}
      </RightPanelHeader>

      {/* Both mounted and toggled via `hidden` to eliminate the unmount/remount
          flash when switching panels. The first mount pays the cost for both
          subtrees; subsequent toggles are instant and preserve scroll/focus.

          Each pane gets its own ErrorBoundary so a Tiptap/WeekGrid render
          error stays contained — the other pane (and the rest of the shell)
          stays usable. The editor boundary is keyed on activePageId so
          navigating to a different page also clears any prior crash. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={ui.rightPanel !== "editor"}>
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <PaneErrorFallback error={error} label="Editor" onReset={reset} />
          )}
          key={ui.activePageId ?? "no-page"}
        >
          <EditorPane />
        </ErrorBoundary>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" hidden={ui.rightPanel !== "calendar"}>
        {/* Hidden, the calendar keeps its state but takes no updates: it re-rendered its week
            with every view switch and every edit. */}
        <Activity mode={ui.rightPanel === "calendar" ? "visible" : "hidden"}>
          <ErrorBoundary
            fallback={({ error, reset }) => (
              <PaneErrorFallback error={error} label="Calendar" onReset={reset} />
            )}
          >
            <CalendarView />
          </ErrorBoundary>
        </Activity>
      </div>
    </div>
  );
}
