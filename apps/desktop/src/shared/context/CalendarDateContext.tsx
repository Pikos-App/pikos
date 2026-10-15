import { createContext, type ReactNode, useContext } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

interface CalendarDateValue {
  /** The day the calendar is anchored on: the week or month around it is shown. */
  referenceDate: Date;
  setReferenceDate: (d: Date) => void;
}

const CalendarDateContext = createContext<CalendarDateValue | null>(null);

/**
 * The calendar's date, apart from the rest of the UI state: stepping a week re-renders the
 * calendar and its header, not every reader of `useUI()`.
 */
export function CalendarDateProvider({ children }: { children: ReactNode }) {
  const [referenceDateIso, setReferenceDateIso] = useLocalStorage<string>(
    STORAGE_KEYS.calendarReferenceDate,
    new Date().toISOString()
  );
  const value: CalendarDateValue = {
    referenceDate: new Date(referenceDateIso),
    setReferenceDate: (d) => setReferenceDateIso(d.toISOString()),
  };
  return <CalendarDateContext.Provider value={value}>{children}</CalendarDateContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCalendarDate(): CalendarDateValue {
  const ctx = useContext(CalendarDateContext);
  if (!ctx) throw new Error("useCalendarDate must be used within <UIProvider>");
  return ctx;
}
