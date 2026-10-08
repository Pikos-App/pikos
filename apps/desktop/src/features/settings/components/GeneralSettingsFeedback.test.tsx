import { NoopPlatformAdapter } from "@pikos/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setPlatform } from "@/shared/platform";

import { GeneralSettingsFeedback } from "./GeneralSettingsFeedback";

afterEach(() => {
  cleanup();
  setPlatform(null);
  vi.unstubAllGlobals();
});

describe("GeneralSettingsFeedback", () => {
  // qa: SET-10:3
  it("copies the feedback address and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<GeneralSettingsFeedback />);

    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("hello@pikos.app");
  });

  // qa: SET-10:3
  it("reports a bug on the bug page with the OS and version filled in", () => {
    vi.stubGlobal("__APP_VERSION__", "9.9.9");
    const platform = new NoopPlatformAdapter();
    setPlatform(platform);
    render(<GeneralSettingsFeedback />);

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    const opened = platform.calls.find((c) => c.method === "openExternal");
    const url = new URL(String(opened?.args[0]));
    expect(url.origin + url.pathname).toBe("https://pikos.app/bugs");
    expect(url.searchParams.get("os")).toMatch(/^(macOS|Linux)$/);
    expect(url.searchParams.get("version")).toBe("9.9.9");
  });
});
