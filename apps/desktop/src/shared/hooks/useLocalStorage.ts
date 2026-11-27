import { useState } from "react";

import { getKeyValueStore } from "@/shared/kv";

function readItem<T>(key: string, fallback: T): T {
  const raw = getKeyValueStore().getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
    // eslint-disable-next-line pikos/no-silent-catch -- a stored value of the wrong shape is the key's default, and this runs on every render
  } catch {
    // Stored value isn't the shape this key holds: fall back rather than surface a parse error.
    return fallback;
  }
}

function writeItem<T>(key: string, value: T): void {
  getKeyValueStore().setItem(key, JSON.stringify(value));
}

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
