// MetadataHeader — synced (locked) + detached provenance rendering.
// Verifies: a locked page's title is read-only (no button affordance, click does
// not enter edit mode); a detached page shows the disconnected notice; the
// reminder bell shows on a locked timed page whether or not it recurs (synced
// recurring occurrences now fire per-occurrence).

import type { Page } from "@pikos/core";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { EditorSettingsProvider } from "@/shared/context/EditorSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { MetadataHeader } from "./MetadataHeader";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makePage(over: Partial<Page>): Page {
  return {
    content: "",
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    priority: 0,
    scheduledEnd: "2099-01-05T10:00:00",
    scheduledStart: "2099-01-05T09:00:00",
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Team sync",
    updatedAt: "2026-01-01T00:00:00",
    ...over,
  };
}

type PagesApi = ReturnType<typeof usePages>;
type WorkspaceApi = ReturnType<typeof useWorkspace>;

function Harness({
  onApi,
  page,
}: {
  onApi: (api: PagesApi, ws: WorkspaceApi) => void;
  page: Page;
}) {
  const pages = usePages();
  const workspace = useWorkspace();
  onApi(pages, workspace);
  return (
    <AppSettingsProvider>
      <EditorSettingsProvider>
        <TooltipProvider>
          <MetadataHeader onFocusEditor={vi.fn()} page={page} />
        </TooltipProvider>
      </EditorSettingsProvider>
    </AppSettingsProvider>
  );
}

async function renderHeader(page: Page) {
  let pagesApi!: PagesApi;
  let workspaceApi!: WorkspaceApi;
  const utils = renderWithProviders(
    <Harness
      onApi={(p, w) => {
        pagesApi = p;
        workspaceApi = w;
      }}
      page={page}
    />
  );
  await act(async () => {
    await workspaceApi.selectWorkspace();
  });
  return { ...utils, pagesApi: () => pagesApi };
}

describe("MetadataHeader — locked title", () => {
  it("renders a locked page title as read-only (no button, click does not edit)", async () => {
    await renderHeader(makePage({ scheduleLocked: true, syncState: "active", title: "Team sync" }));

    const title = screen.getByLabelText("Page title");
    expect(title).not.toHaveAttribute("role", "button");

    fireEvent.click(title);
    // No textarea editor appears — the title stays a static div.
    expect(screen.queryByRole("textbox", { name: "Page title" })).not.toBeInTheDocument();
  });

  it("renders an unlocked page title as an editable button", async () => {
    await renderHeader(makePage({ scheduleLocked: false, syncState: null, title: "Team sync" }));
    expect(screen.getByRole("button", { name: "Page title" })).toBeInTheDocument();
  });
});

describe("MetadataHeader — detached notice", () => {
  it("shows the disconnected notice for a detached page", async () => {
    await renderHeader(makePage({ scheduleLocked: false, syncState: "detached" }));
    expect(screen.getByText(/Disconnected from/)).toBeInTheDocument();
  });

  it("omits the disconnected notice for an active synced page", async () => {
    await renderHeader(makePage({ scheduleLocked: true, syncState: "active" }));
    expect(screen.queryByText(/Disconnected from/)).not.toBeInTheDocument();
  });
});

describe("MetadataHeader — read-only mirror metadata", () => {
  it("renders location + attendees read-only on a locked page", async () => {
    await renderHeader(
      makePage({
        mirrorAttendees: ["alex@example.com", "sam@example.com"],
        mirrorLocation: "Room 4B",
        scheduleLocked: true,
        syncState: "active",
      })
    );
    expect(screen.getByText("Room 4B")).toBeInTheDocument();
    // Multiple attendees collapse to a count.
    expect(screen.getByText("2 guests")).toBeInTheDocument();
  });

  it("omits mirror metadata on a native (unlocked) page", async () => {
    await renderHeader(
      makePage({ mirrorAttendees: ["alex@example.com"], mirrorLocation: "Room 4B" })
    );
    expect(screen.queryByText("Room 4B")).not.toBeInTheDocument();
  });
});

describe("MetadataHeader — calendar description-changed notice", () => {
  it("shows the notice on a locked page with a pending description, revealing the text on View", async () => {
    await renderHeader(
      makePage({
        pendingDescription: "New agenda for the meeting.",
        scheduleLocked: true,
        syncState: "active",
      })
    );
    expect(screen.getByText(/calendar description changed/i)).toBeInTheDocument();
    // Parked text is hidden until the user opens it.
    expect(screen.queryByText("New agenda for the meeting.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("New agenda for the meeting.")).toBeInTheDocument();
  });

  it("omits the notice when pendingDescription is null", async () => {
    await renderHeader(
      makePage({ pendingDescription: null, scheduleLocked: true, syncState: "active" })
    );
    expect(screen.queryByText(/calendar description changed/i)).not.toBeInTheDocument();
  });

  it("omits the notice on a native page even if a stale pendingDescription is present", async () => {
    await renderHeader(makePage({ pendingDescription: "stale", scheduleLocked: false }));
    expect(screen.queryByText(/calendar description changed/i)).not.toBeInTheDocument();
  });
});

describe("MetadataHeader — reminder bell on locked pages", () => {
  it("shows the reminder bell on a locked RECURRING series", async () => {
    const page = makePage({ id: "rec1", scheduleLocked: true, syncState: "active" });
    const { pagesApi } = await renderHeader(page);
    await act(async () => {
      await pagesApi().createRecurrence({
        pageId: "rec1",
        rrule: "FREQ=DAILY",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });
    expect(screen.getByLabelText(/reminder/i)).toBeInTheDocument();
  });

  it("shows the reminder bell on a locked NON-recurring timed page", async () => {
    await renderHeader(makePage({ id: "one1", scheduleLocked: true, syncState: "active" }));
    expect(screen.getByLabelText(/reminder/i)).toBeInTheDocument();
  });
});
