// The two pieces of quick-add that reach past the page row itself: the reminder
// rows a parsed lead writes, and the body a "//" separator fills in. Both are
// asserted against the adapter, because that is where they land — the dialog
// closes immediately and has no state left to inspect.

import { MockStorageAdapter } from "@pikos/core/testing";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { QuickAddDialog } from "./QuickAddDialog";

// globals: false in the vitest config → the auto-cleanup never runs.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The debounced page write (800ms) has to land before content assertions. */
const WRITE_TIMEOUT = 4000;

function Harness() {
  const { setOpenDialog } = useUI();
  return (
    <>
      <button onClick={() => setOpenDialog("quick-add")}>open quick add</button>
      <QuickAddDialog />
    </>
  );
}

/** Opens the dialog, types `text`, and commits it with Enter. */
async function quickAdd(text: string) {
  renderWithProviders(
    <AppSettingsProvider>
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
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
    // The words stayed in the title, exactly as the parser left them.
    expect(createPage.mock.calls[0]![0].title).toBe("Call mom remind 30m before");
    expect(createReminder).not.toHaveBeenCalled();
  });

  it("previews the lead as a chip while typing", async () => {
    const input = await quickAdd("");
    fireEvent.change(input, { target: { value: "Dentist tomorrow at 3pm remind 2h before" } });

    expect(await screen.findByText("2 hours before")).toBeTruthy();
  });
});

describe("QuickAddDialog — body separator", () => {
  it("writes the text after // as the page body", async () => {
    const updatePage = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    await quickAdd("Buy a gift // she likes the blue one");

    await waitFor(
      () => {
        const patch = updatePage.mock.calls.map((c) => c[1]).find((p) => p.contentText != null);
        expect(patch?.contentText).toBe("she likes the blue one");
        expect(JSON.parse(patch!.content!)).toEqual({
          content: [
            { content: [{ text: "she likes the blue one", type: "text" }], type: "paragraph" },
          ],
          type: "doc",
        });
      },
      { timeout: WRITE_TIMEOUT }
    );
  });

  it("keeps the body verbatim — a #word in it is not a tag", async () => {
    const updatePage = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    await quickAdd("Buy a gift // remember the #blue one");

    await waitFor(
      () => {
        const patch = updatePage.mock.calls.map((c) => c[1]).find((p) => p.contentText != null);
        expect(patch?.contentText).toBe("remember the #blue one");
        expect(patch?.tags).toBeUndefined();
      },
      { timeout: WRITE_TIMEOUT }
    );
  });

  it("titles the page from the left of the separator and still parses it", async () => {
    const createPage = vi.spyOn(MockStorageAdapter.prototype, "createPage");
    await quickAdd("Call mom tomorrow at 3pm #family // ask about the trip");

    await waitFor(() => expect(createPage).toHaveBeenCalledOnce());
    expect(createPage.mock.calls[0]![0].title).toBe("Call mom");
  });
});
