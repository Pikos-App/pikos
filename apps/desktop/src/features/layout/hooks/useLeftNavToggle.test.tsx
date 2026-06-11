import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useUI } from "@/shared/context/UIContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useLeftNavToggle } from "./useLeftNavToggle";

function setWidth(w: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w, writable: true });
  window.dispatchEvent(new Event("resize"));
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
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const nav = useLeftNavToggle();
      return { nav, ui };
    });

    expect(result.current.nav.isOpen).toBe(true);
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
  });

  it("isOpen mirrors !sidebarCollapsed at lg", () => {
    setWidth(1100);
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const nav = useLeftNavToggle();
      return { nav, ui };
    });

    expect(result.current.nav.isOpen).toBe(true);
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
  });

  it("isOpen mirrors !sidebarCollapsed at md", () => {
    setWidth(900);
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const nav = useLeftNavToggle();
      return { nav, ui };
    });

    expect(result.current.nav.isOpen).toBe(true);
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
  });

  it("toggle flips sidebarCollapsed (and not the drawer) at large widths", () => {
    setWidth(1480);
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const nav = useLeftNavToggle();
      return { nav, ui };
    });

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
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const nav = useLeftNavToggle();
      return { nav, ui };
    });

    expect(result.current.nav.isOpen).toBe(false);
    act(() => result.current.ui.setPageListDrawerOpen(true));
    expect(result.current.nav.isOpen).toBe(true);
  });

  it("toggle flips pageListDrawerOpen (and not sidebarCollapsed) at sm", () => {
    setWidth(600);
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const nav = useLeftNavToggle();
      return { nav, ui };
    });

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
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const nav = useLeftNavToggle();
      return { nav, ui };
    });

    // Persisted collapsed state shouldn't leak through the sm-mode branch.
    act(() => result.current.ui.setSidebarCollapsed(true));
    expect(result.current.nav.isOpen).toBe(false);
    act(() => result.current.ui.setPageListDrawerOpen(true));
    expect(result.current.nav.isOpen).toBe(true);
  });
});
