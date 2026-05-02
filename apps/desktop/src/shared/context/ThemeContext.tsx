// ThemeContext — owns theme mode (dark / light / system) and resolved theme.
// Applies .dark class to <html>, listens for OS preference changes in system mode,
// manages theme-transitioning class for smooth switches, and updates <meta name="theme-color">.

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { createLogger } from "@/shared/logger";

const log = createLogger("Theme");

// ─── Types ────────────────────────────────────────────────────────────────────

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export interface ThemeContextValue {
  /** User-selected mode: dark, light, or system. */
  mode: ThemeMode;
  /** Actual applied theme after resolving "system" to dark or light. */
  resolvedTheme: ResolvedTheme;
  /** Change the theme mode. Persists to localStorage and applies immediately. */
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "pikos-theme";

/** Surface colors used for <meta name="theme-color"> — must match app.css tokens. */
const META_COLORS: Record<ResolvedTheme, string> = {
  dark: "#161613",
  light: "#ffffff",
};

function readStoredMode(): ThemeMode {
  const t = localStorage.getItem(STORAGE_KEY);
  if (t === "light" || t === "system") return t;
  return "dark";
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

function applyToDOM(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");

  // Update <meta name="theme-color">
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", META_COLORS[resolved]);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(mode));

  function setTheme(next: ThemeMode) {
    const root = document.documentElement;
    root.classList.add("theme-transitioning");

    setModeState(next);
    localStorage.setItem(STORAGE_KEY, next);

    const resolved = resolveTheme(next);
    setResolvedTheme(resolved);
    applyToDOM(resolved);

    setTimeout(() => root.classList.remove("theme-transitioning"), 250);
  }

  // Listen for OS preference changes when in "system" mode.
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function handler() {
      const resolved = resolveTheme("system");
      setResolvedTheme(resolved);
      applyToDOM(resolved);
    }
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  // Sync meta tag on mount (index.html inline script handles .dark class but not meta).
  useEffect(() => {
    applyToDOM(resolvedTheme);
    log.debug(`Applied theme on mount: mode=${mode} resolved=${resolvedTheme}`);
  }, []);

  const value: ThemeContextValue = { mode, resolvedTheme, setTheme };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
