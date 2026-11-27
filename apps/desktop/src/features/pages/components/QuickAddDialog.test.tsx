// The quick-add pieces that reach past the page row: the reminder rows a parsed lead writes, and
// the body a "//" separator fills in. Asserted against the adapter, since the dialog closes at once
// and has no state left to inspect.

import { formatDateOnly, localToday } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { addDays } from "date-fns";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { STORAGE_KEYS } from "@/shared/constants/storage";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { CalendarSettingsProvider } from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { QuickAddDialog } from "./QuickAddDialog";

// globals: false in the vitest config → the auto-cleanup never runs.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function Harness() {
  const { setOpenDialog } = useUI();
  return (
    <>
      <button onClick={() => setOpenDialog("quick-add")}>open quick add</button>
      <QuickAddDialog />
    </>
  );
}

async function quickAdd(text: string) {
  renderWithProviders(
    <AppSettingsProvider>
      <CalendarSettingsProvider>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </CalendarSettingsProvider>
    </AppSettingsProvider>
  );
  // The workspace initialises asynchronously; until it has, `storage` is null
  // and the reminder write would be a no-op.
  await waitFor(() => expect(screen.getByRole("button", { name: "open quick add" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "open quick add" }));
  const input = await screen.findByLabelText("Quick add input");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input;
}

describe("QuickAddDialog — parsed reminders", () => {
  it("writes the parsed lead as a reminder row on the new page", async () => {
    const createReminder = vi.spyOn(MockStorageAdapter.prototype, "createPageReminder");
    await quickAdd("Dentist tomorrow at 3pm remind 30m before");

    await waitFor(() => expect(createReminder).toHaveBeenCalledOnce());
    expect(createReminder.mock.calls[0]![0].minutesBefore).toBe(30);
  });

  it("writes the day-before anchor for an all-day page", async () => {
    const createReminder = vi.spyOn(MockStorageAdapter.prototype, "createPageReminder");
    await quickAdd("Dentist tomorrow remind day before");

    await waitFor(() => expect(createReminder).toHaveBeenCalledOnce());
    expect(createReminder.mock.calls[0]![0].minutesBefore).toBe(-2);
  });

  it("writes one row per accumulated lead", async () => {
    const createReminder = vi.spyOn(MockStorageAdapter.prototype, "createPageReminder");
    await quickAdd("Ship it tomorrow at 3pm remind 1h before remind 30m before");

    await waitFor(() => expect(createReminder).toHaveBeenCalledTimes(2));
    expect(createReminder.mock.calls.map((c) => c[0].minutesBefore)).toEqual([30, 60]);
  });

  it("writes nothing when the lead has no schedule to anchor to", async () => {
    const createReminder = vi.spyOn(MockStorageAdapter.prototype, "createPageReminder");
    const createPage = vi.spyOn(MockStorageAdapter.prototype, "createPage");
    await quickAdd("Call mom remind 30m before");

    await waitFor(() => expect(createPage).toHaveBeenCalledOnce());
    expect(createPage.mock.calls[0]![0].title).toBe("Call mom remind 30m before");
    expect(createReminder).not.toHaveBeenCalled();
  });

  it("previews the lead as a chip while typing", async () => {
    const input = await quickAdd("");
    fireEvent.change(input, { target: { value: "Dentist tomorrow at 3pm remind 2h before" } });

    expect(await screen.findByText("2 hours before")).toBeTruthy();
  });
});

describe("QuickAddDialog — the day a dateless line lands on", () => {
  const inTwoWeeks = addDays(new Date(), 14);

  function showToday(rightPanel: "calendar" | "editor") {
    localStorage.setItem(STORAGE_KEYS.lastActiveViewId, JSON.stringify("today"));
    localStorage.setItem(STORAGE_KEYS.rightPanel, JSON.stringify(rightPanel));
    localStorage.setItem(
      STORAGE_KEYS.calendarReferenceDate,
      JSON.stringify(inTwoWeeks.toISOString())
    );
  }

  // qa: QADD-14
  it("is the calendar's day, from Today with the calendar on another week", async () => {
    showToday("calendar");
    const createSchedule = vi.spyOn(MockStorageAdapter.prototype, "createPageSchedule");
    await quickAdd("Water the plants");

    await waitFor(() => expect(createSchedule).toHaveBeenCalledOnce());
    expect(createSchedule.mock.calls[0]![0].scheduledStart).toBe(formatDateOnly(inTwoWeeks));
  });

  it("is today, from Today with the calendar out of sight", async () => {
    showToday("editor");
    const createSchedule = vi.spyOn(MockStorageAdapter.prototype, "createPageSchedule");
    await quickAdd("Water the plants");

    await waitFor(() => expect(createSchedule).toHaveBeenCalledOnce());
    expect(createSchedule.mock.calls[0]![0].scheduledStart).toBe(localToday());
  });
});

describe("QuickAddDialog — body separator", () => {
  it("creates the page with the text after // as its body", async () => {
    const createPage = vi.spyOn(MockStorageAdapter.prototype, "createPage");
    await quickAdd("Buy a gift // she likes the blue one");

    await waitFor(() => expect(createPage).toHaveBeenCalledOnce());
    const created = createPage.mock.calls[0]![0];
    expect(JSON.parse(created.content)).toEqual({
      content: [{ content: [{ text: "she likes the blue one", type: "text" }], type: "paragraph" }],
      type: "doc",
    });
  });

  it("keeps the body verbatim — a #word in it is not a tag", async () => {
    const createPage = vi.spyOn(MockStorageAdapter.prototype, "createPage");
    await quickAdd("Buy a gift // remember the #blue one");

    await waitFor(() => expect(createPage).toHaveBeenCalledOnce());
    const created = createPage.mock.calls[0]![0];
    expect(created.content).toContain("remember the #blue one");
    expect(created.tags).toEqual([]);
  });

  it("creates the page with its tags, not in a write after it", async () => {
    const createPage = vi.spyOn(MockStorageAdapter.prototype, "createPage");
    await quickAdd("second #work");

    await waitFor(() => expect(createPage).toHaveBeenCalledOnce());
    expect(createPage.mock.calls[0]![0].tags).toEqual(["work"]);
  });

  it("titles the page from the left of the separator and still parses it", async () => {
    const createPage = vi.spyOn(MockStorageAdapter.prototype, "createPage");
    await quickAdd("Call mom tomorrow at 3pm #family // ask about the trip");

    await waitFor(() => expect(createPage).toHaveBeenCalledOnce());
    expect(createPage.mock.calls[0]![0].title).toBe("Call mom");
  });
});

describe("QuickAddDialog — a refused write", () => {
  it("says what went wrong and keeps the dialog open with the text intact", async () => {
    vi.spyOn(MockStorageAdapter.prototype, "createPage").mockRejectedValue(
      new Error("disk is full")
    );
    const input = await quickAdd("Buy milk");

    expect(
      await screen.findByText(
        "Something went wrong while adding the page. Try again, and restart Pikos if it keeps happening."
      )
    ).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("Buy milk");
  });

  it("clears the message once the user types again", async () => {
    vi.spyOn(MockStorageAdapter.prototype, "createPage").mockRejectedValue(
      new Error("disk is full")
    );
    const input = await quickAdd("Buy milk");
    await screen.findByText(
      "Something went wrong while adding the page. Try again, and restart Pikos if it keeps happening."
    );

    fireEvent.change(input, { target: { value: "Buy oat milk" } });

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Something went wrong while adding the page. Try again, and restart Pikos if it keeps happening."
        )
      ).toBeNull()
    );
  });
});
