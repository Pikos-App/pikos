// Regression: delete → undo must not duplicate pages.
//
// QA soft-launch cluster A (§8 "delete pages then undo → duplicates them +
// breaks list rendering", §18 undo jank). `completedPages` is derived from the
// PagesContext `pages` array, so a duplicate id there renders twice in the
// Completed section and confuses the virtualizer. The two invariants below
// guard the fix: restore must dedupe (never blind-append), and soft-delete must
// remove from local state synchronously so a fast undo can't interleave.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

async function setup() {
  const hook = renderHookWithProviders(() => ({
    pages: usePages(),
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
  return hook;
}

function idsOf(hook: Awaited<ReturnType<typeof setup>>) {
  return hook.result.current.pages.pages.map((p) => p.id);
}

describe("PagesContext delete → undo", () => {
  it("restorePage does not duplicate a page already present (the delete/undo race)", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "A" });
      id = p.id;
    });

    // Restore while the page is still in the list — exactly what happens when
    // undo interleaves with a still-pending soft-delete. Must not create a
    // second copy. (Pre-fix this blind-appended → two entries.)
    await act(async () => {
      await hook.result.current.pages.restorePage(id);
    });

    expect(idsOf(hook).filter((x) => x === id)).toHaveLength(1);
  });

  it("soft-delete removes from local state synchronously, before the adapter await", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "A" });
      id = p.id;
    });

    // Fire-and-forget like UndoDeleteContext does (`void softDeletePage`). The
    // page must be gone from `pages` immediately, not only after the await.
    act(() => {
      void hook.result.current.pages.softDeletePage(id);
    });
    expect(idsOf(hook)).not.toContain(id);
  });

  it("deleting several pages then undoing all leaves exactly one of each (no doubling)", async () => {
    const hook = await setup();
    const ids: string[] = [];
    await act(async () => {
      for (const t of ["A", "B", "C"]) {
        const p = await hook.result.current.pages.createPage({ title: t });
        ids.push(p.id);
      }
    });

    await act(async () => {
      await Promise.all(ids.map((id) => hook.result.current.pages.softDeletePage(id)));
    });
    expect(ids.every((id) => !idsOf(hook).includes(id))).toBe(true);

    await act(async () => {
      await Promise.all(ids.map((id) => hook.result.current.pages.restorePage(id)));
    });

    const present = idsOf(hook);
    for (const id of ids) {
      expect(present.filter((x) => x === id)).toHaveLength(1);
    }
    // No duplicate ids anywhere in the array.
    expect(new Set(present).size).toBe(present.length);
  });
});
