import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppSettingsProvider, useAppSettings } from "./AppSettingsContext";

function wrapper({ children }: { children: ReactNode }) {
  return <AppSettingsProvider>{children}</AppSettingsProvider>;
}

function setup() {
  return renderHook(() => useAppSettings(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("weekStart", () => {
  it("defaults to 1 (Monday)", () => {
    const { result } = setup();
    expect(result.current.weekStart).toBe(1);
  });

  it("can be set to 0 (Sunday)", () => {
    const { result } = setup();
    act(() => result.current.setWeekStart(0));
    expect(result.current.weekStart).toBe(0);
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setWeekStart(0));
    expect(JSON.parse(localStorage.getItem("pikos:weekStart")!)).toBe(0);
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:weekStart", "0");
    const { result } = setup();
    expect(result.current.weekStart).toBe(0);
  });
});

describe("defaultFolderId", () => {
  it("defaults to null (Inbox)", () => {
    const { result } = setup();
    expect(result.current.defaultFolderId).toBeNull();
  });

  it("can be set to a folder ID", () => {
    const { result } = setup();
    act(() => result.current.setDefaultFolderId("folder-123"));
    expect(result.current.defaultFolderId).toBe("folder-123");
  });

  it("can be reset to null", () => {
    const { result } = setup();
    act(() => result.current.setDefaultFolderId("folder-123"));
    act(() => result.current.setDefaultFolderId(null));
    expect(result.current.defaultFolderId).toBeNull();
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setDefaultFolderId("folder-abc"));
    expect(JSON.parse(localStorage.getItem("pikos:defaultFolderId")!)).toBe("folder-abc");
  });
});

// ─── Notification settings ──────────────────────────────────────────────────

describe("autoUpdateEnabled", () => {
  it("defaults to true", () => {
    const { result } = setup();
    expect(result.current.autoUpdateEnabled).toBe(true);
  });

  it("can be toggled off and persists", () => {
    const { result } = setup();
    act(() => result.current.setAutoUpdateEnabled(false));
    expect(result.current.autoUpdateEnabled).toBe(false);
    expect(JSON.parse(localStorage.getItem("pikos:autoUpdateEnabled")!)).toBe(false);
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:autoUpdateEnabled", "false");
    const { result } = setup();
    expect(result.current.autoUpdateEnabled).toBe(false);
  });
});

describe("notificationsEnabled", () => {
  it("defaults to true", () => {
    const { result } = setup();
    expect(result.current.notificationsEnabled).toBe(true);
  });

  it("can be toggled off", () => {
    const { result } = setup();
    act(() => result.current.setNotificationsEnabled(false));
    expect(result.current.notificationsEnabled).toBe(false);
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setNotificationsEnabled(false));
    expect(JSON.parse(localStorage.getItem("pikos:notificationsEnabled")!)).toBe(false);
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:notificationsEnabled", "false");
    const { result } = setup();
    expect(result.current.notificationsEnabled).toBe(false);
  });
});

describe("defaultReminderMinutes", () => {
  it("defaults to 10", () => {
    const { result } = setup();
    expect(result.current.defaultReminderMinutes).toBe(10);
  });

  it("can be changed to any valid lead time", () => {
    const { result } = setup();
    act(() => result.current.setDefaultReminderMinutes(30));
    expect(result.current.defaultReminderMinutes).toBe(30);
    act(() => result.current.setDefaultReminderMinutes(0));
    expect(result.current.defaultReminderMinutes).toBe(0);
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setDefaultReminderMinutes(5));
    expect(JSON.parse(localStorage.getItem("pikos:defaultReminderMinutes")!)).toBe(5);
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:defaultReminderMinutes", "30");
    const { result } = setup();
    expect(result.current.defaultReminderMinutes).toBe(30);
  });
});

describe("overdueAlerts", () => {
  it("defaults to true", () => {
    const { result } = setup();
    expect(result.current.overdueAlerts).toBe(true);
  });

  it("can be toggled off and persists", () => {
    const { result } = setup();
    act(() => result.current.setOverdueAlerts(false));
    expect(result.current.overdueAlerts).toBe(false);
    expect(JSON.parse(localStorage.getItem("pikos:overdueAlerts")!)).toBe(false);
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:overdueAlerts", "false");
    const { result } = setup();
    expect(result.current.overdueAlerts).toBe(false);
  });
});

describe("summaryTime", () => {
  it("defaults to 07:00", () => {
    const { result } = setup();
    expect(result.current.summaryTime).toBe("07:00");
  });

  it("can be changed and persists", () => {
    const { result } = setup();
    act(() => result.current.setSummaryTime("09:00"));
    expect(result.current.summaryTime).toBe("09:00");
    expect(JSON.parse(localStorage.getItem("pikos:summaryTime")!)).toBe("09:00");
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:summaryTime", JSON.stringify("06:30"));
    const { result } = setup();
    expect(result.current.summaryTime).toBe("06:30");
  });
});

describe("quiet hours", () => {
  it("defaults to disabled with 22:00-08:00 window", () => {
    const { result } = setup();
    expect(result.current.quietHoursEnabled).toBe(false);
    expect(result.current.quietHoursStart).toBe("22:00");
    expect(result.current.quietHoursEnd).toBe("08:00");
  });

  it("can enable quiet hours and change times", () => {
    const { result } = setup();
    act(() => result.current.setQuietHoursEnabled(true));
    act(() => result.current.setQuietHoursStart("21:00"));
    act(() => result.current.setQuietHoursEnd("07:00"));

    expect(result.current.quietHoursEnabled).toBe(true);
    expect(result.current.quietHoursStart).toBe("21:00");
    expect(result.current.quietHoursEnd).toBe("07:00");
  });

  it("persists all quiet hours settings to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setQuietHoursEnabled(true));
    act(() => result.current.setQuietHoursStart("23:00"));
    act(() => result.current.setQuietHoursEnd("06:00"));

    expect(JSON.parse(localStorage.getItem("pikos:quietHoursEnabled")!)).toBe(true);
    expect(JSON.parse(localStorage.getItem("pikos:quietHoursStart")!)).toBe("23:00");
    expect(JSON.parse(localStorage.getItem("pikos:quietHoursEnd")!)).toBe("06:00");
  });

  it("reads persisted quiet hours on mount", () => {
    localStorage.setItem("pikos:quietHoursEnabled", JSON.stringify(true));
    localStorage.setItem("pikos:quietHoursStart", JSON.stringify("20:00"));
    localStorage.setItem("pikos:quietHoursEnd", JSON.stringify("07:00"));
    const { result } = setup();
    expect(result.current.quietHoursEnabled).toBe(true);
    expect(result.current.quietHoursStart).toBe("20:00");
    expect(result.current.quietHoursEnd).toBe("07:00");
  });
});
