// MetadataHeader — synced (locked) + detached provenance rendering.
// Verifies: a locked title is read-only; a detached page shows the disconnected
// notice; the reminder bell shows on a locked page whether or not it recurs.

import { CONTENT_SCHEMA_VERSION } from "@pikos/core";
import type { Page } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { JSONContent } from "@tiptap/core";
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
    contentSchemaVersion: CONTENT_SCHEMA_VERSION,
    createdAt: "2026-01-01T00:00:00",
    detachIsReversible: false,
    folderId: null,
    id: "p1",
    isRecurring: false,
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
  onAppendToBody,
  page,
}: {
  onApi: (api: PagesApi, ws: WorkspaceApi) => void;
  onAppendToBody: (doc: JSONContent) => boolean;
  page: Page;
}) {
  const pages = usePages();
  const workspace = useWorkspace();
  onApi(pages, workspace);
  return (
    <AppSettingsProvider>
      <EditorSettingsProvider>
        <TooltipProvider>
          <MetadataHeader onAppendToBody={onAppendToBody} onFocusEditor={vi.fn()} page={page} />
        </TooltipProvider>
      </EditorSettingsProvider>
    </AppSettingsProvider>
  );
}

async function renderHeader(
  page: Page,
  onAppendToBody: (doc: JSONContent) => boolean = vi.fn(() => true)
) {
  let pagesApi!: PagesApi;
  let workspaceApi!: WorkspaceApi;
  const utils = renderWithProviders(
    <Harness
      onApi={(p, w) => {
        pagesApi = p;
        workspaceApi = w;
      }}
      onAppendToBody={onAppendToBody}
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

// The other half of the lock, and the half nothing else asserts. A synced page is
// meant to be first-class apart from its title and schedule, so the byline keeps
// every control the calendar does not own. Widening the lock to the whole header
// is the easy regression — it looks safer, it reads as "synced means read-only",
// and the read-only tests above all keep passing while the page goes inert.
describe("MetadataHeader — a locked mirror keeps what the calendar doesn't own", () => {
  const mirror = () => makePage({ scheduleLocked: true, syncState: "active", tags: ["work"] });

  it("offers the priority picker", async () => {
    await renderHeader(mirror());
    expect(screen.getByRole("button", { name: /^Priority:/ })).toBeEnabled();
  });

  it("offers the tag picker", async () => {
    await renderHeader(mirror());
    expect(screen.getByRole("button", { name: /^Tags:/ })).toBeEnabled();
  });

  it("offers the status toggle", async () => {
    await renderHeader(mirror());
    expect(screen.getByRole("button", { name: "Mark done" })).toBeEnabled();
  });
});

// The notice splits on whether the detach can be undone, not on what caused it —
// that is the only part the reader can act on. Both arms name the thing as a
// calendar: the folder carries the same name and stays in the sidebar, so a
// notice saying only "Removed from Work" reads as contradicting the folder chip
// beside it. Two screen reviews filed that as a bug.
describe("MetadataHeader — pages linking here", () => {
  const linker = (id: string) => makePage({ id, title: `Linker ${id}` });

  it("shows the count in the byline, after the tags", async () => {
    vi.spyOn(MockStorageAdapter.prototype, "listBacklinks").mockResolvedValue([
      linker("a"),
      linker("b"),
    ]);
    await renderHeader(makePage({ tags: ["work"] }));

    const links = await screen.findByRole("button", { name: "Linked from 2 pages" });
    const tags = screen.getByRole("button", { name: /^Tags:/ });
    expect(tags.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Page title")).not.toContainElement(links);
  });

  it("leaves the byline ending at the tags when nothing links here", async () => {
    vi.spyOn(MockStorageAdapter.prototype, "listBacklinks").mockResolvedValue([]);
    await renderHeader(makePage({ tags: ["work"] }));

    const tags = screen.getByRole("button", { name: /^Tags:/ });
    expect(screen.queryByRole("button", { name: /^Linked from/ })).not.toBeInTheDocument();
    expect(tags.closest(".flex-wrap")?.lastElementChild).toContainElement(tags);
  });
});

describe("MetadataHeader — detached notice", () => {
  it("says a page can rejoin when its calendar is only switched off", async () => {
    await renderHeader(
      makePage({ detachIsReversible: true, scheduleLocked: false, syncState: "detached" })
    );
    expect(screen.getByText(/The .* calendar is turned off\. Turn it back on/)).toBeInTheDocument();
  });

  it("says a page is its own when the event is gone from the provider", async () => {
    await renderHeader(
      makePage({ detachIsReversible: false, scheduleLocked: false, syncState: "detached" })
    );
    expect(
      screen.getByText(/Removed from the .* calendar\. This is a regular page now\./)
    ).toBeInTheDocument();
  });

  it("omits the notice for an active synced page", async () => {
    await renderHeader(makePage({ scheduleLocked: true, syncState: "active" }));
    expect(screen.queryByText(/turned off|Removed from/)).not.toBeInTheDocument();
  });
});

describe("MetadataHeader — read-only mirror metadata", () => {
  it("renders location + attendees read-only on a locked page", async () => {
    await renderHeader(
      makePage({
        detachIsReversible: false,
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
        detachIsReversible: false,
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

  async function clickAppend(appended: boolean) {
    const doc = { content: [{ type: "paragraph" }], type: "doc" };
    vi.spyOn(MockStorageAdapter.prototype, "pendingDescriptionDocument").mockResolvedValue(
      JSON.stringify(doc)
    );
    const clear = vi
      .spyOn(MockStorageAdapter.prototype, "clearPendingDescription")
      .mockResolvedValue();
    const append = vi.fn(() => appended);
    await renderHeader(
      makePage({
        detachIsReversible: false,
        pendingDescription: "New agenda for the meeting.",
        scheduleLocked: true,
        syncState: "active",
      }),
      append
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Append" }));
      await Promise.resolve();
    });

    return { append, clear, doc };
  }

  it("hands the parked description's document to the editor on Append, then clears it", async () => {
    const { append, clear, doc } = await clickAppend(true);

    expect(append).toHaveBeenCalledWith(doc);
    expect(clear).toHaveBeenCalledWith("p1");
  });

  it("keeps the description parked when the editor took nothing", async () => {
    const { clear } = await clickAppend(false);

    expect(clear).not.toHaveBeenCalled();
  });

  it("leaves the body alone on Dismiss", async () => {
    const append = vi.fn(() => true);
    await renderHeader(
      makePage({
        detachIsReversible: false,
        pendingDescription: "New agenda for the meeting.",
        scheduleLocked: true,
        syncState: "active",
      }),
      append
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(append).not.toHaveBeenCalled();
  });

  // No replace action, deliberately: the notice only fires because the user
  // edited the body, so replacing destroys what raised it.
  it("offers no action that overwrites the body", async () => {
    await renderHeader(
      makePage({
        detachIsReversible: false,
        pendingDescription: "New agenda.",
        scheduleLocked: true,
        syncState: "active",
      })
    );
    expect(screen.queryByRole("button", { name: /replace|use the calendar/i })).toBeNull();
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

describe("MetadataHeader — locked recurrence label", () => {
  it("names the position of a BYSETPOS series", async () => {
    const page = makePage({ id: "rec2", scheduleLocked: true, syncState: "active" });
    const { pagesApi } = await renderHeader(page);
    await act(async () => {
      await pagesApi().createRecurrence({
        pageId: "rec2",
        rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });
    expect(screen.getByText("every month on the 3rd Friday")).toBeInTheDocument();
  });
});

describe("MetadataHeader — why a locked field can't be edited", () => {
  it("explains the lock from the hint beside a locked title", async () => {
    await renderHeader(makePage({ scheduleLocked: true, syncState: "active" }));

    const hint = screen.getByRole("img", { name: /are read-only for synced pages/ });
    fireEvent.pointerMove(hint, { pointerType: "mouse" });
    expect((await screen.findAllByText(/are read-only for synced pages/)).length).toBeGreaterThan(
      0
    );
  });

  // The lock is the one trigger. Resting on a locked field used to pop a tooltip
  // of its own, which then parked over whatever sat below it.
  it("leaves the locked title and schedule themselves silent", async () => {
    await renderHeader(makePage({ scheduleLocked: true, syncState: "active" }));

    fireEvent.pointerMove(screen.getByLabelText("Page title"), { pointerType: "mouse" });
    fireEvent.pointerMove(screen.getByLabelText(/^Scheduled:/), { pointerType: "mouse" });
    expect(screen.queryByText(/are read-only for synced pages/)).not.toBeInTheDocument();
  });

  it("leaves an unlocked title with no such explanation", async () => {
    await renderHeader(makePage({ scheduleLocked: false, syncState: null }));

    fireEvent.pointerMove(screen.getByRole("button", { name: "Page title" }), {
      pointerType: "mouse",
    });
    expect(
      screen.queryByRole("img", { name: /are read-only for synced pages/ })
    ).not.toBeInTheDocument();
  });
});

// The caret is placed once, when the field swaps from its div to its textarea.
// Re-placing it on every value change is what made typing into the middle of a
// title impossible: each keystroke threw the caret back to the end.
describe("MetadataHeader — the caret stays where you put it", () => {
  async function focusField(name: string) {
    await renderHeader(makePage({ scheduleLocked: false, subtitle: "Weekly", syncState: null }));
    fireEvent.click(screen.getByRole("button", { name }));
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name });
    const setSelectionRange = vi.spyOn(field, "setSelectionRange");
    return { field, setSelectionRange };
  }

  it("does not move the caret while you type in the title", async () => {
    const { field, setSelectionRange } = await focusField("Page title");

    fireEvent.change(field, { target: { value: "Team Xsync" } });

    expect(setSelectionRange).not.toHaveBeenCalled();
  });

  it("does not move the caret while you type in the description", async () => {
    const { field, setSelectionRange } = await focusField("Page description");

    fireEvent.change(field, { target: { value: "WeXekly" } });

    expect(setSelectionRange).not.toHaveBeenCalled();
  });

  it("puts the caret at the end when the title opens for editing", async () => {
    await renderHeader(makePage({ scheduleLocked: false, syncState: null, title: "Team sync" }));

    fireEvent.click(screen.getByRole("button", { name: "Page title" }));

    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Page title" });
    expect(field.selectionStart).toBe("Team sync".length);
  });
});

describe.each([
  { field: "title", label: "Page title" },
  { field: "subtitle", label: "Page description" },
] as const)("MetadataHeader — a $field synced in while its field is open", ({ field, label }) => {
  const page = makePage({ scheduleLocked: false, subtitle: "Weekly", syncState: null });

  async function openField() {
    const { rerender } = await renderHeader(page);
    fireEvent.click(screen.getByRole("button", { name: label }));
    return (synced: string) =>
      rerender(
        <Harness onApi={vi.fn()} onAppendToBody={vi.fn()} page={{ ...page, [field]: synced }} />
      );
  }

  it("shows the synced value in the open field", async () => {
    const syncIn = await openField();

    syncIn("changed on the phone");

    expect(screen.getByRole("textbox", { name: label })).toHaveValue("changed on the phone");
  });

  it("keeps what is typed when the store has not caught up with it", async () => {
    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockImplementation((id, patch) =>
      Promise.resolve(makePage({ id, ...patch }))
    );
    const syncIn = await openField();
    fireEvent.change(screen.getByRole("textbox", { name: label }), {
      target: { value: "typed on the Mac" },
    });

    syncIn("changed on the phone");

    expect(screen.getByRole("textbox", { name: label })).toHaveValue("typed on the Mac");
  });
});

// The 800ms auto-save debounce is meant to flush on blur. It did not:
// the only flush listened on `window`'s blur, which fires when the whole app
// loses focus and never when focus moves between elements inside it. So moving
// from the title into the body left the rename unwritten, and anything reading
// storage in that window — search, the CLI, a quit — saw the old title.
describe("MetadataHeader — leaving a field commits it", () => {
  async function editField(label: string, value: string) {
    // The harness renders a page object without seeding it into the adapter, so
    // the real updatePage would reject on a missing row. Resolving here keeps the
    // assertion on "was it called, and when" rather than on the mock's bookkeeping.
    const updatePage = vi
      .spyOn(MockStorageAdapter.prototype, "updatePage")
      .mockImplementation((id, patch) => Promise.resolve(makePage({ id, ...patch })));
    await renderHeader(makePage({ scheduleLocked: false, syncState: null, title: "Team sync" }));

    fireEvent.click(screen.getByRole("button", { name: label }));
    const field = screen.getByRole("textbox", { name: label });
    fireEvent.change(field, { target: { value } });
    updatePage.mockClear();

    return { field, updatePage };
  }

  it("writes the title on blur instead of waiting out the debounce", async () => {
    const { field, updatePage } = await editField("Page title", "zenith proposal");

    expect(updatePage).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.blur(field);
      await Promise.resolve();
    });

    expect(updatePage).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ title: "zenith proposal" })
    );
  });

  it("writes the description on blur", async () => {
    const { field, updatePage } = await editField("Page description", "the quarterly one");

    await act(async () => {
      fireEvent.blur(field);
      await Promise.resolve();
    });

    expect(updatePage).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ subtitle: "the quarterly one" })
    );
  });

  it("writes the title when Enter moves focus to the description", async () => {
    const { field, updatePage } = await editField("Page title", "zenith proposal");

    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
      await Promise.resolve();
    });

    expect(updatePage).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ title: "zenith proposal" })
    );
  });
});
