import { addMonths, getMonth, getYear, subMonths } from "date-fns";
import { useState } from "react";

export interface MonthNav {
  year: number;
  month: number;
  next: () => void;
  prev: () => void;
  reset: (date: Date) => void;
}

export function useMonthNav(initial: Date = new Date()): MonthNav {
  const [year, setYear] = useState(() => getYear(initial));
  const [month, setMonth] = useState(() => getMonth(initial));

  function next() {
    const stepped = addMonths(new Date(year, month, 1), 1);
    setYear(getYear(stepped));
    setMonth(getMonth(stepped));
  }

  function prev() {
    const stepped = subMonths(new Date(year, month, 1), 1);
    setYear(getYear(stepped));
    setMonth(getMonth(stepped));
  }

  function reset(date: Date) {
    setYear(getYear(date));
    setMonth(getMonth(date));
  }

  return { month, next, prev, reset, year };
}
