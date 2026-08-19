// The palette has two query paths that must stay distinguishable: a plain query
// is one FTS5 search, an operator query is a structured listPages filter. These
// specs pin which path answers which query, and what the completed toggle says.

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { PagesContextValue } from "@/shared/context/PagesContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import type { WorkspaceContextValue } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { SearchPalette } from "./SearchPalette";

// The adapter is per-provider-tree, so seeding has to happen from inside the
// same tree the palette renders in — hence a probe rather than a setup call.
type Api = {
  pages: PagesContextValue;
  setOpenDialog: (d: "search" | null) => void;
  workspace: WorkspaceContextValue;
};
const apiRef: { current: Api | null } = { current: null };

function CaptureApi() {
  const pages = usePages();
  const workspace = useWorkspace();
  const { setOpenDialog } = useUI();
  useEffect(() => {
    apiRef.current = { pages, setOpenDialog, workspace };
  }, [pages, setOpenDialog, workspace]);
  return null;
}

function api(): Api {
  const current = apiRef.current;
  if (!current) throw new Error("api probe never mounted");
  return current;
}

interface SeedPage {
  title: string;
  body?: string;
  done?: boolean;
  folderId?: string | null;
  priority?: 0 | 1 | 2 | 3 | 4;
  scheduledStart?: string;
  tags?: string[];
}

async function seed(pages: SeedPage[]) {
  const storage = api().workspace.storage;
  if (!storage) throw new Error("storage should be available after selectWorkspace");
  for (const p of pages) {
    await storage.createPage({
      content: "",
      contentText: p.body ?? "",
      folderId: p.folderId ?? null,
      priority: p.priority ?? 0,
      status: p.done ? "done" : "not_started",
      subtitle: null,
      tags: p.tags ?? [],
      title: p.title,
      ...(p.scheduledStart !== undefined && { scheduledStart: p.scheduledStart }),
    });
  }
  await api().workspace.reload();
}

/** Mount the palette, initialise the workspace, seed pages, then open it. */
async function setup(pages: SeedPage[] = [], folderNames: string[] = []) {
  renderWithProviders(
    <>
      <CaptureApi />
      <SearchPalette />
    </>
  );
  await act(async () => {
    await api().workspace.selectWorkspace();
  });
  const folders: Record<string, string> = {};
  await act(async () => {
    for (const name of folderNames) {
      const folder = await api().pages.createFolder({ name });
      folders[name] = folder.id;
    }
  });
  if (pages.length > 0) {
    await act(async () => {
      await seed(pages.map((p) => ({ ...p, folderId: resolveSeedFolder(p.folderId, folders) })));
    });
  }
  act(() => {
    api().setOpenDialog("search");
  });
  return folders;
}

function resolveSeedFolder(
  folderId: string | null | undefined,
  folders: Record<string, string>
): string | null {
  if (folderId == null) return null;
  return folders[folderId] ?? folderId;
}

function type(value: string) {
  const input = screen.getByPlaceholderText(/Search pages/);
  fireEvent.change(input, { target: { value } });
}

/** Result rows are buttons; matching on the accessible name survives the
 *  <span> splitting that highlighting introduces inside a title. */
function findRow(title: string) {
  return screen.findByRole("button", { name: new RegExp(title) });
}

function queryRow(title: string) {
  return screen.queryByRole("button", { name: new RegExp(title) });
}

afterEach(cleanup);

// ─── Plain queries — the FTS5 path ─────────────────────────────────────────

describe("SearchPalette — plain queries", () => {
  it("returns the FTS match and drops the rest", async () => {
    await setup([{ title: "alpha report" }, { title: "beta notes" }]);

    type("alpha");

    expect(await findRow("alpha report")).toBeInTheDocument();
    expect(queryRow("beta notes")).toBeNull();
  });

  it("waits for two characters before querying", async () => {
    await setup([{ title: "alpha report" }]);

    type("a");

    await new Promise((r) => setTimeout(r, 250));
    expect(queryRow("alpha report")).toBeNull();
  });

  it("hides completed matches behind the toggle", async () => {
    await setup([{ title: "alpha report" }, { done: true, title: "alpha archive" }]);

    type("alpha");

    expect(await findRow("alpha report")).toBeInTheDocument();
    expect(queryRow("alpha archive")).toBeNull();

    fireEvent.click(await screen.findByText("Show completed (1)"));

    expect(await findRow("alpha archive")).toBeInTheDocument();
  });
});

// ─── Operator queries — the listPages filter path ──────────────────────────

describe("SearchPalette — operators", () => {
  it("filters by tag without any free text", async () => {
    await setup([
      { tags: ["work"], title: "alpha report" },
      { tags: ["home"], title: "beta notes" },
    ]);

    type("tag:work");

    expect(await findRow("alpha report")).toBeInTheDocument();
    expect(queryRow("beta notes")).toBeNull();
  });

  it("runs an operator query on a single character, below the FTS floor", async () => {
    await setup([{ tags: ["work"], title: "alpha report" }]);

    type("tag:work");

    expect(await findRow("alpha report")).toBeInTheDocument();
  });

  it("intersects the filter with the free text around it", async () => {
    await setup([
      { tags: ["work"], title: "alpha report" },
      { tags: ["work"], title: "beta notes" },
    ]);

    type("tag:work alpha");

    expect(await findRow("alpha report")).toBeInTheDocument();
    expect(queryRow("beta notes")).toBeNull();
  });

  it("filters by priority", async () => {
    await setup([
      { priority: 1, title: "alpha urgent" },
      { priority: 4, title: "beta someday" },
    ]);

    type("priority:urgent");

    expect(await findRow("alpha urgent")).toBeInTheDocument();
    expect(queryRow("beta someday")).toBeNull();
  });

  it("filters by folder name, fuzzily", async () => {
    await setup([{ folderId: "Work", title: "alpha report" }, { title: "beta notes" }], ["Work"]);

    type("folder:wor");

    expect(await findRow("alpha report")).toBeInTheDocument();
    expect(queryRow("beta notes")).toBeNull();
  });

  it("returns nothing for a folder name that matches no folder", async () => {
    await setup([{ title: "alpha report" }]);

    type("folder:nowhere");

    expect(await screen.findByText("No pages found")).toBeInTheDocument();
    expect(queryRow("alpha report")).toBeNull();
  });

  it("filters by due date range", async () => {
    await setup([
      { scheduledStart: "2026-03-18", title: "alpha soon" },
      { scheduledStart: "2026-06-01", title: "beta later" },
      { title: "gamma unscheduled" },
    ]);

    type("due:2026-03-01..2026-03-31");

    expect(await findRow("alpha soon")).toBeInTheDocument();
    expect(queryRow("beta later")).toBeNull();
    expect(queryRow("gamma unscheduled")).toBeNull();
  });

  it("filters to scheduled pages with is:scheduled", async () => {
    await setup([
      { scheduledStart: "2026-03-18", title: "alpha soon" },
      { title: "beta unscheduled" },
    ]);

    type("is:scheduled");

    expect(await findRow("alpha soon")).toBeInTheDocument();
    expect(queryRow("beta unscheduled")).toBeNull();
  });

  it("keeps an unknown operator as search text", async () => {
    await setup([{ title: "ratio:1 experiment" }, { title: "beta notes" }]);

    type("ratio:1");

    expect(await findRow("ratio:1 experiment")).toBeInTheDocument();
    expect(queryRow("beta notes")).toBeNull();
  });
});

// ─── is:done vs the completed toggle ───────────────────────────────────────

describe("SearchPalette — is:done", () => {
  it("surfaces completed pages without the toggle being on", async () => {
    await setup([{ title: "alpha open" }, { done: true, title: "alpha archived" }]);

    type("is:done");

    expect(await findRow("alpha archived")).toBeInTheDocument();
    expect(queryRow("alpha open")).toBeNull();
  });

  it("reports that the operator, not the toggle, is showing them", async () => {
    await setup([{ done: true, title: "alpha archived" }]);

    type("is:done");

    expect(await screen.findByText("Showing completed — is:done")).toBeInTheDocument();
    expect(screen.queryByText(/Show completed \(/)).toBeNull();
  });

  it("keeps completed pages out for is:open", async () => {
    await setup([{ title: "alpha open" }, { done: true, title: "alpha archived" }]);

    type("is:open");

    expect(await findRow("alpha open")).toBeInTheDocument();
    await waitFor(() => {
      expect(queryRow("alpha archived")).toBeNull();
    });
  });
});
