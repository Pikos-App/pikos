import { useSyncExternalStore } from "react";

function subscribe(callback: () => void): () => void {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

function getSnapshot(): number {
  return window.innerWidth;
}

function getServerSnapshot(): number {
  return 1480;
}

/**
 * Returns the current window inner width, updating on resize.
 * Uses useSyncExternalStore so all subscribers share a single listener
 * and stay consistent during concurrent renders.
 */
export function useWindowWidth(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
