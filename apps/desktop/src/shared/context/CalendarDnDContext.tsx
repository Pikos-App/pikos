// CalendarDnDContext — imperative bridge between page-list drag and the
// calendar grid's ghost preview. WeekGrid registers a function that maps
// cursor coords to a drop slot (and updates its own ghost state). The page
// list's drag handler calls it on every mousemove. Lives outside UIContext
// because the imperative-ref pattern is calendar-specific noise for the rest
// of the UI.

import { createContext, type ReactNode, useContext, useRef, useState } from "react";

export type ExternalDragUpdater = (
  clientX: number,
  clientY: number,
  folderColor: string | undefined,
  durationMs?: number,
  title?: string,
  isDone?: boolean
) => { start: string } | null;

export interface CalendarDnDContextValue {
  /** True while a page-list item is being dragged over the calendar panel. */
  isDraggingOverCalendar: boolean;
  setIsDraggingOverCalendar: (v: boolean) => void;
  registerExternalDragUpdater: (fn: ExternalDragUpdater | null) => void;
  callExternalDragUpdater: ExternalDragUpdater;
}

const CalendarDnDContext = createContext<CalendarDnDContextValue | null>(null);

export function CalendarDnDProvider({ children }: { children: ReactNode }) {
  const [isDraggingOverCalendar, setIsDraggingOverCalendar] = useState(false);
  const externalDragUpdaterRef = useRef<ExternalDragUpdater | null>(null);

  function registerExternalDragUpdater(fn: ExternalDragUpdater | null) {
    externalDragUpdaterRef.current = fn;
  }

  const callExternalDragUpdater: ExternalDragUpdater = (
    clientX,
    clientY,
    folderColor,
    durationMs,
    title,
    isDone
  ) =>
    externalDragUpdaterRef.current?.(clientX, clientY, folderColor, durationMs, title, isDone) ??
    null;

  const value: CalendarDnDContextValue = {
    callExternalDragUpdater,
    isDraggingOverCalendar,
    registerExternalDragUpdater,
    setIsDraggingOverCalendar,
  };

  return <CalendarDnDContext.Provider value={value}>{children}</CalendarDnDContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCalendarDnD(): CalendarDnDContextValue {
  const ctx = useContext(CalendarDnDContext);
  if (!ctx) throw new Error("useCalendarDnD must be used within <CalendarDnDProvider>");
  return ctx;
}
