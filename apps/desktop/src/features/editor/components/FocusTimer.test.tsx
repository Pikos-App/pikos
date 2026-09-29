// The timer's UI contract: quiet play button at rest, elapsed count + stop while
// running, and a stop that hands the session to the adapter. The timing rules
// themselves are pinned on the hook (`useFocusTimer.test.ts`).

import type { MockStorageAdapter } from "@pikos/core";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { FocusTimer } from "./FocusTimer";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type WorkspaceApi = ReturnType<typeof useWorkspace>;

function Harness({ onApi, pageId }: { onApi: (ws: WorkspaceApi) => void; pageId: string }) {
  const workspace = useWorkspace();
  onApi(workspace);
  return (
    <TooltipProvider>
      <FocusTimer pageId={pageId} />
    </TooltipProvider>
  );
}

/** Renders against a real workspace so `storage` is the MockStorageAdapter the
 *  app uses in test mode, then plants the page the writer insists on. */
async function renderTimer() {
  let workspaceApi!: WorkspaceApi;
  const utils = renderWithProviders(<Harness onApi={(w) => (workspaceApi = w)} pageId="pending" />);
  await act(async () => {
    await workspaceApi.selectWorkspace();
  });
  const adapter = workspaceApi.storage as MockStorageAdapter;
  const page = await act(async () =>
    adapter.createPage({
      content: "",
      folderId: null,
      priority: 0,
      status: "not_started",
      tags: [],
      title: "Deep work",
    })
  );
  utils.rerender(<Harness onApi={(w) => (workspaceApi = w)} pageId={page.id} />);
  return { ...utils, adapter, pageId: page.id };
}

describe("FocusTimer", () => {
  it("renders only a start button at rest", async () => {
    await renderTimer();
    expect(screen.getByRole("button", { name: "Start focus timer" })).toBeInTheDocument();
    expect(screen.queryByTestId("focus-elapsed")).not.toBeInTheDocument();
  });

  it("swaps to an elapsed count and a stop button once started", async () => {
    await renderTimer();

    fireEvent.click(screen.getByRole("button", { name: "Start focus timer" }));

    expect(screen.getByTestId("focus-elapsed")).toHaveTextContent("0:00");
    expect(screen.getByRole("button", { name: "Stop focus timer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start focus timer" })).not.toBeInTheDocument();
  });

  it("stop hands the finished session to storage and returns to rest", async () => {
    const { adapter } = await renderTimer();
    // A real session, not a sub-floor one: the hook discards anything shorter.
    // Fake timers rather than a `Date.now` spy — the hook stamps the session with
    // `new Date()`, which only a moved system clock affects.
    const createFocusSession = vi.spyOn(adapter, "createFocusSession");
    vi.useFakeTimers({ shouldAdvanceTime: false });

    fireEvent.click(screen.getByRole("button", { name: "Start focus timer" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByTestId("focus-elapsed")).toHaveTextContent("2:00");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop focus timer" }));
      await Promise.resolve();
    });

    expect(createFocusSession).toHaveBeenCalledTimes(1);
    expect(createFocusSession.mock.calls[0]![0].durationS).toBe(120);
    expect(screen.getByRole("button", { name: "Start focus timer" })).toBeInTheDocument();
  });

  it("a session stopped under the floor is not written", async () => {
    const { adapter } = await renderTimer();
    const createFocusSession = vi.spyOn(adapter, "createFocusSession");

    fireEvent.click(screen.getByRole("button", { name: "Start focus timer" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop focus timer" }));
      await Promise.resolve();
    });

    expect(createFocusSession).not.toHaveBeenCalled();
  });
});
