// EditorPanel — right panel. Owns the shared header (RightPanelHeader) and
// toggles between EditorPane and CalendarView via Cmd+Shift+C.

import { addWeeks, subWeeks } from "date-fns";

import { CalendarHeader } from "@/features/calendar/CalendarHeader";
import { CalendarView } from "@/features/calendar/CalendarView";
import { EditorPane } from "@/features/editor";
import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { RightPanelHeader } from "./RightPanelHeader";

export function EditorPanel() {
  const ui = useUI();

  useKeyboardShortcut(
    "Mod+Shift+C",
    () => {
      ui.setRightPanel(ui.rightPanel === "editor" ? "calendar" : "editor");
    },
    { allowInInputs: true }
  );

  useKeyboardShortcut(
    "Mod+\\",
    () => {
      ui.setSidebarCollapsed(!ui.sidebarCollapsed);
    },
    { allowInInputs: true }
  );

  function handlePrevWeek() {
    ui.setReferenceDate(subWeeks(ui.referenceDate, 1));
  }

  function handleNextWeek() {
    ui.setReferenceDate(addWeeks(ui.referenceDate, 1));
  }

  function handleToday() {
    ui.setReferenceDate(new Date());
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      <RightPanelHeader>
        {ui.rightPanel === "calendar" && (
          <CalendarHeader
            onNextWeek={handleNextWeek}
            onPrevWeek={handlePrevWeek}
            onToday={handleToday}
            referenceDate={ui.referenceDate}
          />
        )}
      </RightPanelHeader>

      {ui.rightPanel === "editor" ? <EditorPane /> : <CalendarView />}
    </div>
  );
}
