// useLeftNavToggle — unified open/close behaviour for the left nav across
// breakpoints. At sm the page list is an overlay drawer; at md/lg/xl the
// sidebar collapse flag controls visibility instead.

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UIProvider, useUI } from "@/shared/context/UIContext";

import { useLeftNavToggle } from "./useLeftNavToggle";

function setWidth(w: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w, writable: true });
  window.dispatchEvent(new Event("resize"));
}

function wrapper({ children }: { children: ReactNode }) {
  return <UIProvider>{children}</UIProvider>;
}

beforeEach(() => {
  localStorage.clear();
  setWidth(1480); // xl by default
});
afterEach(() => {
  localStorage.clear();
});

describe("useLeftNavToggle — large layout (xl/lg/md)", () => {
  it("isOpen mirrors !sidebarCollapsed at xl", () => {
    setWidth(1480);
    const { result } = renderHook(
      () => {
        const ui = useUI();
        const nav = useLeftNavToggle();
        return { nav, ui };
      },
      { wrapper }
    );

    expect(result.current.nav.isOpen).toBe(true);
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
  });

  it("isOpen mirrors !sidebarCollapsed at lg", () => {
    setWidth(1100);
    const { result } = renderHook(
      () => {
        const ui = useUI();
        const nav = useLeftNavToggle();
        return { nav, ui };
      },
      { wrapper }
    );

    expect(result.current.nav.isOpen).toBe(true);
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
  });

  it("isOpen mirrors !sidebarCollapsed at md", () => {
    setWidth(900);
    const { result } = renderHook(
      () => {
        const ui = useUI();
        const nav = useLeftNavToggle();
        return { nav, ui };
      },
      { wrapper }
    );

    expect(result.current.nav.isOpen).toBe(true);
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
  });

  it("toggle flips sidebarCollapsed (and not the drawer) at large widths", () => {
    setWidth(1480);
    const { result } = renderHook(
      () => {
        const ui = useUI();
        const nav = useLeftNavToggle();
        return { nav, ui };
      },
      { wrapper }
    );

    expect(result.current.ui.sidebarCollapsed).toBe(false);
    act(() => result.current.nav.toggle());
    expect(result.current.ui.sidebarCollapsed).toBe(true);
    expect(result.current.ui.pageListDrawerOpen).toBe(false);

    act(() => result.current.nav.toggle());
    expect(result.current.ui.sidebarCollapsed).toBe(false);
  });
});

describe("useLeftNavToggle — small layout (sm)", () => {
  it("isOpen mirrors pageListDrawerOpen at sm", () => {
    setWidth(600);
    const { result } = renderHook(
      () => {
        const ui = useUI();
        const nav = useLeftNavToggle();
        return { nav, ui };
      },
      { wrapper }
    );

    expect(result.current.nav.isOpen).toBe(false);
    act(() => result.current.ui.setPageListDrawerOpen(true));
    expect(result.current.nav.isOpen).toBe(true);
  });

  it("toggle flips pageListDrawerOpen (and not sidebarCollapsed) at sm", () => {
    setWidth(600);
    const { result } = renderHook(
      () => {
        const ui = useUI();
        const nav = useLeftNavToggle();
        return { nav, ui };
      },
      { wrapper }
    );

    expect(result.current.ui.pageListDrawerOpen).toBe(false);
    expect(result.current.ui.sidebarCollapsed).toBe(false);
    act(() => result.current.nav.toggle());
    expect(result.current.ui.pageListDrawerOpen).toBe(true);
    expect(result.current.ui.sidebarCollapsed).toBe(false);

    act(() => result.current.nav.toggle());
    expect(result.current.ui.pageListDrawerOpen).toBe(false);
  });

  it("does not consult sidebarCollapsed for openness at sm", () => {
    setWidth(600);
    const { result } = renderHook(
      () => {
        const ui = useUI();
        const nav = useLeftNavToggle();
        return { nav, ui };
      },
      { wrapper }
    );

    // Persisted collapsed state shouldn't leak through the sm-mode branch.
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
    act(() => result.current.ui.setPageListDrawerOpen(true));
    expect(result.current.nav.isOpen).toBe(true);
  });
});
