import type { PageSummary } from "@pikos/core";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRecurringGapDialog } from "@/shared/context/RecurringGapDialogContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";
import { usePagesNow } from "@/test/usePagesNow";

import { RecurringGapDialog } from "./RecurringGapDialog";

function Harness() {
  const { selectWorkspace } = useWorkspace();
  const pages = usePagesNow();
  const { requestComplete, requestDelete } = useRecurringGapDialog();
  const [seriesId, setSeriesId] = useState<string | null>(null);

  async function seed() {
    await selectWorkspace();
    const series = await pages.createPage({ title: "Standup" });
    await pages.scheduleOnce(series.id, "2099-01-05T09:00:00");
    await pages.createRecurrence({
      pageId: series.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2099-01-05T09:00:00",
      timezone: "America/New_York",
    });
    setSeriesId(series.id);
  }

  function head(): PageSummary {
    const page = pages.pages.find((p) => p.id === seriesId);
    if (!page) throw new Error("series not held");
    return page;
  }

  function occurrenceOn(date: string): PageSummary {
    return {
      ...head(),
      isVirtual: true,
      originalDate: date,
      scheduledStart: `${date}T09:00:00`,
    } as PageSummary;
  }

  return (
    <>
      <button onClick={() => void seed()}>Seed</button>
      {seriesId && (
        <>
          <button onClick={() => requestComplete(head())}>Tick the head</button>
          <button onClick={() => requestDelete(occurrenceOn("2099-01-06"))}>Delete Jan 6</button>
        </>
      )}
      <RecurringGapDialog />
    </>
  );
}

async function setup() {
  renderWithProviders(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Seed" }));
  await screen.findByRole("button", { name: "Tick the head" });
}

const BACKLOG = "3 days before today are still open: Mon Jan 5, Tue Jan 6, Wed Jan 7.";

describe("RecurringGapDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-08T12:00:00"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ticking the head names its day and lists every day the bulk option marks", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Tick the head" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Mark “Standup” done for Mon Jan 5?",
    });
    expect(dialog).toHaveTextContent(BACKLOG);
    expect(dialog).toHaveTextContent("Marks Mon Jan 5 done. The other 2 days stay open.");
    expect(dialog).toHaveTextContent("Marks all 3 days done.");
  });

  it("a delete names the day it deletes and lists the same days as a tick", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete Jan 6" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete “Standup” on Tue Jan 6?" });
    expect(dialog).toHaveTextContent(BACKLOG);
    expect(dialog).toHaveTextContent("Deletes Tue Jan 6. The other 2 days stay open.");
    expect(dialog).toHaveTextContent("Deletes all 3 days.");
  });
});
