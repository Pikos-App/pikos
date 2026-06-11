// The placeholder cursor persists in localStorage so a returning user keeps
// seeing new syntax instead of restarting at the simplest example every launch.

import { useEffect, useState } from "react";

/**
 * Ordered simple → complex so a new user sees plain titles first and is
 * gradually exposed to date, time, tag, priority, and recurrence syntax.
 * Tone matches the tutorial seed: casual, personal, non-technical.
 */
const EXAMPLES = [
  "Buy milk",
  "Pick up dry cleaning tomorrow",
  "Submit timesheet friday",
  "Yoga tonight",
  "Dentist next thursday 2pm",
  "Lunch with Tom friday 12pm #social",
  "Vet appointment monday 3pm !high",
  "Water the plants every 3 days",
  "Stretch every morning for 4 weeks",
  "Date night every other friday 7pm",
] as const;

export const QUICK_ADD_PLACEHOLDER_EXAMPLES = EXAMPLES;

const STORAGE_KEY = "pikos:quickAddPlaceholderIndex";

function modIndex(n: number): number {
  return ((n % EXAMPLES.length) + EXAMPLES.length) % EXAMPLES.length;
}

function readIndex(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = JSON.parse(raw);
    return typeof parsed === "number" && Number.isFinite(parsed) ? modIndex(parsed) : 0;
  } catch {
    return 0;
  }
}

function writeIndex(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(modIndex(value)));
  } catch {
    // localStorage unavailable (e.g. private browsing) — ignore
  }
}

export function useQuickAddPlaceholder(isOpen: boolean): string {
  // Track the prior `isOpen` value so we can advance the index *during render*
  // when the dialog transitions closed→open (React-recommended pattern for
  // adjusting state on a prop change). The localStorage write stays in an
  // effect — it's a real side-effect, unlike the in-render state update.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  const [shownIndex, setShownIndex] = useState<number>(readIndex);

  if (prevOpen !== isOpen) {
    setPrevOpen(isOpen);
    if (isOpen) setShownIndex(readIndex());
  }

  useEffect(() => {
    if (isOpen) writeIndex(shownIndex + 1);
  }, [isOpen, shownIndex]);

  return EXAMPLES[shownIndex] ?? EXAMPLES[0];
}
