import { useState } from "react";

import { getKeyValueStore } from "@/shared/kv";

function readItem<T>(key: string, fallback: T): T {
  const raw = getKeyValueStore().getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Stored value isn't the shape this key used to hold — fall back rather
    // than surface a parse error the user can do nothing about.
    return fallback;
  }
}

function writeItem<T>(key: string, value: T): void {
  getKeyValueStore().setItem(key, JSON.stringify(value));
}

/** useState backed by the platform key-value store. Value is JSON-serialized. */
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
