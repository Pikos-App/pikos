// EditorPanel — right panel. Owns the shared header (RightPanelHeader) and
// toggles between EditorPane and CalendarView via Cmd+Shift+C.

import { addDays, subDays } from "date-fns";

import { CalendarHeader, CalendarView } from "@/features/calendar";
import { EditorPane } from "@/features/editor";
import { getCalendarDayCount, useLayoutMode } from "@/features/layout/breakpoints";
import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useLeftNavToggle } from "../hooks/useLeftNavToggle";
import { RightPanelHeader } from "./RightPanelHeader";

export function EditorPanel() {
  const ui = useUI();
  const dayCount = getCalendarDayCount(useLayoutMode());
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
    ui.setReferenceDate(subDays(ui.referenceDate, dayCount));
  }

  function handleNextWeek() {
    ui.setReferenceDate(addDays(ui.referenceDate, dayCount));
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
          subtrees; subsequent toggles are instant and preserve scroll/focus. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={ui.rightPanel !== "editor"}>
        <EditorPane />
      </div>
      <div className="flex min-h-0 flex-1 flex-col" hidden={ui.rightPanel !== "calendar"}>
        <CalendarView />
      </div>
    </div>
  );
}
