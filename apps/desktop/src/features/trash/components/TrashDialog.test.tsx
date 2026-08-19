// The trash, driven the way a user drives it: against MockStorageAdapter, which
// answers `listTrashedPages` / `purgeTrashedPages` with the same divert the Rust
// writers make for a synced mirror.
//
// The restore assertion is the load-bearing one. Clearing `deleted_at` is not
// what the user asked for — seeing the page back in their list is — and those
// are two different code paths, so the probe below watches the live store rather
// than re-reading the trash.

import type { MockStorageAdapter } from "@pikos/core";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import type { WorkspaceContextValue } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { TrashDialog } from "./TrashDialog";

const workspaceRef: { current: WorkspaceContextValue | null } = { current: null };

/** Stands in for the sidebar: opens the dialog through UIContext the way the
 *  Trash entry does, and renders the live page list so a restore is observable. */
function Harness() {
  const workspace = useWorkspace();
  const { setOpenDialog } = useUI();
  const { pages } = usePages();
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  return (
    <>
      <button onClick={() => setOpenDialog("trash")} type="button">
        Open trash
      </button>
      <ul aria-label="Live pages">
        {pages.map((p) => (
          <li key={p.id}>{p.title}</li>
        ))}
      </ul>
    </>
  );
}

function api(): WorkspaceContextValue {
  const workspace = workspaceRef.current;
  if (!workspace) throw new Error("workspace probe never mounted");
  return workspace;
}

/** The mock, not the interface: the seeds below reach for `markPageSynced`,
 *  which is a test seam and deliberately not part of `StorageAdapter`. */
function storage(): MockStorageAdapter {
  const s = api().storage;
  if (!s) throw new Error("no storage adapter");
  return s as MockStorageAdapter;
}

afterEach(cleanup);

async function newPage(title: string, folderId: string | null = null) {
  return storage().createPage({
    content: "",
    contentText: "",
    folderId,
    priority: 0,
    status: "not_started",
    tags: [],
    title,
  });
}

/** Renders, boots the workspace, seeds, then opens the trash — in that order,
 *  because the dialog reads the trash when it opens and not again. */
async function setup(seed: () => Promise<void> = () => Promise.resolve()) {
  renderWithProviders(
    <>
      <Harness />
      <TrashDialog />
    </>
  );
  await act(async () => {
    await api().selectWorkspace();
  });
  await act(async () => {
    await seed();
    await api().reload();
  });
  fireEvent.click(screen.getByRole("button", { name: "Open trash" }));
  await screen.findByRole("dialog", { name: "Trash" });
}

/** Resolves once the fetch behind the open dialog has painted its rows. */
function trashList(): Promise<HTMLElement> {
  return screen.findByRole("list", { name: "Deleted pages" });
}

/** Radix marks everything outside an open dialog `aria-hidden`, which role
 *  queries honour — so the probe list is reached by its label instead. */
function liveList() {
  return screen.getByLabelText("Live pages");
}

describe("TrashDialog", () => {
  it("says how long deletions are kept when there is nothing in it", async () => {
    await setup();

    expect(await screen.findByText("The trash is empty.")).toBeInTheDocument();
    expect(screen.getByText("Deleted pages are kept for 30 days.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Deleted pages" })).toBeNull();
  });

  it("lists a deleted page with its folder and when it went", async () => {
    await setup(async () => {
      const folder = await storage().createFolder({ color: null, name: "Work", parentId: null });
      const page = await newPage("Quarterly report", folder.id);
      await storage().softDeletePage(page.id);
    });

    const row = within(await trashList()).getByText("Quarterly report");
    const meta = row.parentElement!;
    expect(meta).toHaveTextContent("Work");
    expect(meta).toHaveTextContent("Deleted today");
  });

  it("puts a restored page back in the live list, not just back in the database", async () => {
    await setup(async () => {
      const page = await newPage("Second thoughts");
      await storage().softDeletePage(page.id);
    });

    expect(within(liveList()).queryByText("Second thoughts")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Restore Second thoughts" }));

    await waitFor(() => {
      expect(within(liveList()).getByText("Second thoughts")).toBeInTheDocument();
    });
    expect(screen.queryByRole("list", { name: "Deleted pages" })).toBeNull();
  });

  it("refuses to destroy a page a calendar still owns, and says it is synced", async () => {
    await setup(async () => {
      const page = await newPage("Standup");
      storage().markPageSynced(page.id, { state: "active" });
      await storage().softDeletePage(page.id);
    });

    expect(within(await trashList()).getByText("Synced")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Standup forever" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore Standup" })).toBeEnabled();
  });

  it("destroys one page after the confirm names it", async () => {
    await setup(async () => {
      const page = await newPage("Regrettable");
      await storage().softDeletePage(page.id);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Delete Regrettable forever" }));
    expect(await screen.findByText(/gone for good/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));

    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "Deleted pages" })).toBeNull();
    });
    expect(await storage().listTrashedPages()).toHaveLength(0);
  });

  it("empties the trash once the phrase is typed, keeping what sync owns", async () => {
    await setup(async () => {
      const native = await newPage("Mine");
      const mirror = await newPage("Theirs");
      storage().markPageSynced(mirror.id, { state: "active" });
      await storage().softDeletePage(native.id);
      await storage().softDeletePage(mirror.id);
    });

    expect(within(await trashList()).getByText("Mine")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "delete" } });
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));

    await waitFor(async () => {
      expect(within(await trashList()).queryByText("Mine")).toBeNull();
    });
    // The mirror stays: destroying it would drop the tombstone keeping the event
    // out, and the next sync pass would put the page back.
    expect(within(await trashList()).getByText("Theirs")).toBeInTheDocument();
  });
});
