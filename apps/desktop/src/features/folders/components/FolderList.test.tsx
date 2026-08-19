// FolderList — the CALENDARS section. "Personal" is the name Google gives by
// default, so two connected accounts collide there routinely; the account
// heading is the only thing separating them, since the row label mirrors the
// calendar and colour is the user's to set.

import { DndContext } from "@dnd-kit/core";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { useUI } from "@/shared/context/UIContext";
import type { WorkspaceContextValue } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { FolderList } from "./FolderList";

// The adapter is per-provider-tree, so seeding has to happen from inside the same
// tree FolderList renders in — hence a probe rather than a standalone setup call.
const workspaceRef: { current: WorkspaceContextValue | null } = { current: null };

function CaptureWorkspace() {
  const workspace = useWorkspace();
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  return null;
}

/** The sidebar owns no dialog of its own — the Trash entry asks UIContext to
 *  open one, and App renders it. This reads back what the entry asked for. */
function ShowOpenDialog() {
  const { openDialog } = useUI();
  return <span data-testid="open-dialog">{openDialog ?? "none"}</span>;
}

function workspaceApi(): WorkspaceContextValue {
  const workspace = workspaceRef.current;
  if (!workspace) throw new Error("workspace probe never mounted");
  return workspace;
}

// The shared setup registers no auto-cleanup, so an earlier render's rows would
// otherwise still be in the document and duplicate every calendar name.
afterEach(cleanup);

async function connectAccount(displayName: string) {
  const storage = workspaceApi().storage!;
  const account = await storage.connectCaldavAccount({
    baseUrl: "",
    displayName,
    password: "",
    username: "",
  });
  for (const calendar of account.calendars) {
    await storage.toggleSyncCalendar(calendar.id, true, null);
  }
}

async function setup(accountNames: string[]) {
  renderWithProviders(
    <TooltipProvider>
      <DndContext>
        <CaptureWorkspace />
        <ShowOpenDialog />
        <FolderList />
      </DndContext>
    </TooltipProvider>
  );
  await act(async () => {
    await workspaceApi().selectWorkspace();
  });
  await act(async () => {
    for (const name of accountNames) await connectAccount(name);
    await workspaceApi().reload();
  });
}

describe("FolderList — synced calendars", () => {
  it("separates same-named calendars under their account", async () => {
    await setup(["alex@work.com", "alex@home.com"]);

    const work = await screen.findByRole("group", { name: "alex@work.com" });
    const home = await screen.findByRole("group", { name: "alex@home.com" });

    expect(within(work).getByRole("button", { name: "Personal" })).toBeInTheDocument();
    expect(within(home).getByRole("button", { name: "Personal" })).toBeInTheDocument();
  });

  it("shows no account heading when only one account is connected", async () => {
    await setup(["alex@work.com"]);

    expect(await screen.findByRole("button", { name: "Personal" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "alex@work.com" })).toBeNull();
    expect(screen.queryByText("alex@work.com")).toBeNull();
  });
});

describe("FolderList — trash", () => {
  it("offers Trash below the folders and opens it through the dialog surface", async () => {
    await setup([]);

    const trash = await screen.findByRole("button", { name: "Trash" });
    // Bottom of the sidebar, after the smart views and the folder list — the
    // entry is a way into deleted pages, not another place they live.
    const entries = screen.getAllByRole("button", { name: /^(Today|Inbox|Trash)$/ });
    expect(entries.map((e) => e.textContent)).toEqual(["Today", "Inbox", "Trash"]);

    fireEvent.click(trash);
    expect(screen.getByTestId("open-dialog")).toHaveTextContent("trash");
  });
});
