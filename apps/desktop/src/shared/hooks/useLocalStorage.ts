import { useState } from "react";

function readItem<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeItem<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage unavailable (e.g. private browsing) — ignore
  }
}

/** useState backed by localStorage. Value is JSON-serialized. */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setStateRaw] = useState<T>(() => readItem(key, defaultValue));

  function setState(value: T | ((prev: T) => T)) {
    setStateRaw((prev) => {
      const next = typeof value === "function" ? (value as (p: T) => T)(prev) : value;
      writeItem(key, next);
      return next;
    });
  }

  return [state, setState];
}
