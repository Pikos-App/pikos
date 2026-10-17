import type { PageSummary } from "@pikos/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";
import { usePagesNow } from "@/test/usePagesNow";

import { PageListProvider, usePageListContext } from "../PageListContext";
import { SeriesDeleteDialog } from "./SeriesDeleteDialog";

function Harness() {
  const { selectWorkspace } = useWorkspace();
  const pages = usePagesNow();
  const { requestDelete } = usePageListContext();
  const { toastItems } = useUndoDelete();
  const [ids, setIds] = useState<{ plain: string; series: string } | null>(null);

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
    const plain = await pages.createPage({ title: "Groceries" });
    setIds({ plain: plain.id, series: series.id });
  }

  function held(id: string): PageSummary {
    const page = pages.pages.find((p) => p.id === id);
    if (!page) throw new Error(`page ${id} not held`);
    return page;
  }

  return (
    <>
      <button onClick={() => void seed()}>Seed</button>
      {ids && (
        <>
          <button onClick={() => requestDelete(held(ids.series))}>Delete the series</button>
          <button onClick={() => requestDelete(held(ids.series), 2)}>Delete a selection</button>
          <button onClick={() => requestDelete(held(ids.plain))}>Delete the plain page</button>
        </>
      )}
      <ul aria-label="Toasts">
        {toastItems.map((toast) => (
          <li key={toast.id}>{toast.label}</li>
        ))}
      </ul>
      <SeriesDeleteDialog />
    </>
  );
}

async function setup() {
  renderWithProviders(
    <PageListProvider>
      <Harness />
    </PageListProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Seed" }));
  await screen.findByRole("button", { name: "Delete the series" });
}

// While the dialog is up, everything behind it is aria-hidden.
const toasts = () => within(screen.getByRole("list", { hidden: true, name: "Toasts" }));

describe("SeriesDeleteDialog", () => {
  afterEach(cleanup);

  it("asks a series which dates to delete before deleting anything", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete the series" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete “Standup”?" });
    expect(
      within(dialog).getByText(
        "It repeats. Skip just this date, or delete it and every date it has left."
      )
    ).toBeInTheDocument();
    for (const name of ["Skip This Date", "Delete All Dates", "Cancel"]) {
      expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(toasts().queryAllByRole("listitem", { hidden: true })).toHaveLength(0);
  });

  it("skips one date with Undo on Skip This Date", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete the series" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip This Date" }));

    await waitFor(() =>
      expect(toasts().getByText("Deleted one day of “Standup”")).toBeInTheDocument()
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("deletes the series with Undo on Delete All Dates", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete the series" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete All Dates" }));

    expect(toasts().getByText("Deleted “Standup”")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does nothing on Cancel", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete the series" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(toasts().queryAllByRole("listitem", { hidden: true })).toHaveLength(0);
  });

  it("deletes a plain page at once", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete the plain page" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(toasts().getByText("Deleted “Groceries”")).toBeInTheDocument();
  });

  it("deletes a series at once when the gesture acts on a selection", async () => {
    await setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete a selection" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(toasts().getByText("Deleted “Standup”")).toBeInTheDocument();
  });
});
