import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useTrash } from "./useTrash";

function setup() {
  return renderHookWithProviders(() => ({
    pages: usePages(),
    trash: useTrash(true),
  }));
}

describe("useTrash", () => {
  it("lists a page deleted elsewhere while the trash is the open view", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.trash.loading).toBe(false));

    let id = "";
    await act(async () => {
      const page = await hook.result.current.pages.createPage({ title: "Doomed" });
      id = page.id;
    });
    // The deletion comes from somewhere that is not the trash — the calendar, or a
    // shortcut — which is the case the open view used to miss entirely.
    await act(async () => {
      await hook.result.current.pages.softDeletePage(id);
    });

    await waitFor(() =>
      expect(hook.result.current.trash.entries.map((e) => e.title)).toContain("Doomed")
    );
  });

  // The route that stayed broken after the page one was fixed. Deleting a folder
  // takes its pages with it, but the adapter soft-deletes those itself, so no page
  // event fires and the open list showed none of them. The trash lists pages rather
  // than folders, so the folder's own row is not expected here.
  it("lists the pages a folder took with it when the folder was deleted elsewhere", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.trash.loading).toBe(false));

    let folderId = "";
    await act(async () => {
      const folder = await hook.result.current.pages.createFolder({ name: "Doomed folder" });
      folderId = folder.id;
      await hook.result.current.pages.createPage({ folderId, title: "Page inside" });
    });

    await act(async () => {
      await hook.result.current.pages.softDeleteFolder(folderId);
    });

    await waitFor(() =>
      expect(hook.result.current.trash.entries.map((e) => e.title)).toContain("Page inside")
    );
  });

  it("does not read the trash while it is closed", async () => {
    const hook = renderHookWithProviders(() => ({
      pages: usePages(),
      trash: useTrash(false),
    }));

    let id = "";
    await act(async () => {
      const page = await hook.result.current.pages.createPage({ title: "Doomed" });
      id = page.id;
      await hook.result.current.pages.softDeletePage(id);
    });

    expect(hook.result.current.trash.entries).toEqual([]);
  });
});
