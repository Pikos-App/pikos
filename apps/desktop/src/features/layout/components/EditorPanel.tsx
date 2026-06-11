import { addDays, subDays } from "date-fns";

import { CalendarHeader, CalendarView } from "@/features/calendar";
import { EditorPane } from "@/features/editor";
import { getCalendarDayCount, useLayoutMode } from "@/features/layout/breakpoints";
import { PaneErrorFallback } from "@/shared/components/PaneErrorFallback";
import { clampDayCount, dayCountNavStep } from "@/shared/constants/calendar";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useLeftNavToggle } from "../hooks/useLeftNavToggle";
import { RightPanelHeader } from "./RightPanelHeader";

export function EditorPanel() {
  const ui = useUI();
  // Must match CalendarView's effective day count — otherwise prev/next step by
  // the breakpoint max (7) while the view renders fewer days, skipping dates.
  const { dayCount: preferredDayCount } = useCalendarSettings();
  const dayCount = clampDayCount(preferredDayCount, getCalendarDayCount(useLayoutMode()));
  const navStep = dayCountNavStep(dayCount);
  const leftNav = useLeftNavToggle();

  useKeyboardShortcut(
    "Mod+Shift+C",
    () => {
      ui.setRightPanel(ui.rightPanel === "editor" ? "calendar" : "editor");
    },
    { allowInInputs: true }
  );

  useKeyboardShortcut("Mod+\\", leftNav.toggle, { allowInInputs: true });

  function handlePrevWeek() {
    ui.setReferenceDate(subDays(ui.referenceDate, navStep));
  }

  function handleNextWeek() {
    ui.setReferenceDate(addDays(ui.referenceDate, navStep));
  }

  function handleToday() {
    ui.setReferenceDate(new Date());
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      <RightPanelHeader>
        {ui.rightPanel === "calendar" && (
          <CalendarHeader
            dayCount={dayCount}
            onNextWeek={handleNextWeek}
            onPrevWeek={handlePrevWeek}
            onToday={handleToday}
            referenceDate={ui.referenceDate}
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
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <PaneErrorFallback error={error} label="Calendar" onReset={reset} />
          )}
        >
          <CalendarView />
        </ErrorBoundary>
      </div>
    </div>
  );
}
