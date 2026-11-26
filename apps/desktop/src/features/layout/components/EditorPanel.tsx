import { dayCountNavStep } from "@pikos/core";
import { addDays, addMonths, startOfMonth, subDays, subMonths } from "date-fns";
import { Activity, useRef } from "react";

import { CalendarHeader, CalendarView, usePreloadCalendarRange } from "@/features/calendar";
import { EditorPane } from "@/features/editor";
import { CalendarNotSyncingBanner } from "@/features/settings";
import { PaneErrorFallback } from "@/shared/components/PaneErrorFallback";
import { useCalendarDate } from "@/shared/context/CalendarDateContext";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useSelection } from "@/shared/context/SelectionContext";
import { useUI } from "@/shared/context/UIContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useCalendarDayCount } from "@/shared/hooks/useCalendarDays";
import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useLeftNavToggle } from "../hooks/useLeftNavToggle";
import { RightPanelHeader } from "./RightPanelHeader";

export function EditorPanel() {
  const ui = useUI();
  const { referenceDate, setReferenceDate } = useCalendarDate();
  const { setViewMode, viewMode } = useCalendarSettings();
  const dayCount = useCalendarDayCount();
  const navStep = dayCountNavStep(dayCount);
  const isMonth = viewMode === "month";
  const leftNav = useLeftNavToggle();
  const { clearSelection, selectedPageIds } = useSelection();
  usePreloadCalendarRange();

  useKeyboardShortcut(
    "Mod+Shift+C",
    () => {
      ui.setRightPanel(ui.rightPanel === "editor" ? "calendar" : "editor");
    },
    { allowInInputs: true, group: "Navigation", label: "Toggle calendar / editor" }
  );

  const editorPaneRef = useRef<HTMLDivElement>(null);

  useKeyboardShortcut(
    "Escape",
    () => {
      if (selectedPageIds.size > 0) {
        clearSelection();
        return;
      }

      const focused = document.activeElement;
      const isEditorFocused =
        focused instanceof HTMLElement && (editorPaneRef.current?.contains(focused) ?? false);
      if (isEditorFocused) {
        focused.blur();
        return;
      }

      ui.setRightPanel("calendar");
    },
    {
      allowInInputs: true,
      group: "Navigation",
      label: "Clear the selection, leave the editor, or go to the calendar",
      unlessHandled: true,
      when: () =>
        (selectedPageIds.size > 0 || ui.rightPanel === "editor") && !Keyboard.isModalOpen(),
    }
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

  // min-w-0: a flex item's min-width:auto refuses to shrink below its content, so the month grid
  // would grow the panel past the window and push the sidebar and page list off screen.
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
      <CalendarNotSyncingBanner />

      {/* Both mounted and toggled via `hidden` to avoid the unmount/remount flash; the first mount pays
          for both. Each pane has its own ErrorBoundary so a render error stays contained; the editor's is
          keyed on activePageId so navigating to another page clears a prior crash. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        hidden={ui.rightPanel !== "editor"}
        ref={editorPaneRef}
      >
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
