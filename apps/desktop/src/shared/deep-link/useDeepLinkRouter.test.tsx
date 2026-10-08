import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl: Array<(event: { payload: string }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: string }) => void) => {
    if (event === "pikos://open-url") openUrl.push(handler);
    return Promise.resolve(() => {});
  },
}));

import { useUI } from "@/shared/context/UIContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useDeepLinkRouter } from "./useDeepLinkRouter";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

async function setup() {
  const hook = renderHookWithProviders(() => {
    useDeepLinkRouter();
    return useUI();
  });
  await waitFor(() => expect(openUrl).toHaveLength(1));
  const open = (url: string) => act(() => openUrl[0]?.({ payload: url }));
  return { hook, open };
}

beforeEach(() => {
  openUrl.length = 0;
  localStorage.clear();
});

describe("useDeepLinkRouter", () => {
  // qa: WIN-07
  it("routes each link to its place, and a malformed one changes nothing", async () => {
    const { hook, open } = await setup();

    for (const view of ["today", "upcoming", "inbox"]) {
      open(`pikos://${view}`);
      expect(hook.result.current.activeViewId).toBe(view);
    }

    open(`pikos://page/${UUID}`);
    expect(hook.result.current.activePageId).toBe(UUID);

    act(() => hook.result.current.setSettingsOpen(true));
    open("pikos://calendar");
    expect(hook.result.current.rightPanel).toBe("calendar");
    expect(hook.result.current.settingsOpen).toBe(false);

    open("pikos://search?q=meeting%20notes");
    expect(hook.result.current.openDialog).toBe("search");
    expect(hook.result.current.dialogPrefill).toBe("meeting notes");

    open("pikos-staging://quick-add?text=Buy%20milk");
    expect(hook.result.current.openDialog).toBe("quick-add");
    expect(hook.result.current.dialogPrefill).toBe("Buy milk");

    const before = hook.result.current;
    open("pikos://nonsense");
    open("not a url");
    expect(hook.result.current.activeViewId).toBe(before.activeViewId);
    expect(hook.result.current.activePageId).toBe(before.activePageId);
    expect(hook.result.current.openDialog).toBe(before.openDialog);
  });
});
