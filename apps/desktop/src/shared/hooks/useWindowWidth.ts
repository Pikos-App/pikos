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

export function useWindowWidth(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
