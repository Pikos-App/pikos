// CalendarView — right panel calendar mode.
// Reads pages from WorkspaceContext (scheduledStart denorm), renders week view.

import { addWeeks, isSameWeek, subWeeks } from "date-fns";
import { useState } from "react";

import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { CalendarHeader } from "./CalendarHeader";
import { weekDays } from "./calendarUtils";
import { WeekGrid } from "./WeekGrid";

export function CalendarView() {
  const { pages } = useWorkspace();
  const { setActivePage, setRightPanel } = useUI();

  // referenceDate drives which week is shown. We only need one Date per week —
  // it doesn't need to be normalised to Monday because weekDays() handles that.
  const [referenceDate, setReferenceDate] = useState(() => new Date());

  const days = weekDays(referenceDate);
  const isCurrentWeek = isSameWeek(referenceDate, new Date(), { weekStartsOn: 1 });

  function handlePrevWeek() {
    setReferenceDate((d) => subWeeks(d, 1));
  }

  function handleNextWeek() {
    setReferenceDate((d) => addWeeks(d, 1));
  }

  function handleToday() {
    setReferenceDate(new Date());
  }

  function handlePageClick(pageId: string) {
    setActivePage(pageId);
    setRightPanel("editor");
  }

  return (
    <div className="flex h-full flex-col">
      <CalendarHeader
        onNextWeek={handleNextWeek}
        onPrevWeek={handlePrevWeek}
        onToday={handleToday}
        referenceDate={referenceDate}
      />

      <WeekGrid
        days={days}
        isCurrentWeek={isCurrentWeek}
        onPageClick={handlePageClick}
        pages={pages}
      />
    </div>
  );
}
