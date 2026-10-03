import type { TrashedPage } from "@pikos/core";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";
import { usePagesNow } from "@/test/usePagesNow";

import { useTrash } from "./useTrash";

function setup() {
  return renderHookWithProviders(() => ({
    pages: usePagesNow(),
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

  // Restoring the page without its folder used to put it back pointing at a folder
  // that no longer existed, so it came back into nowhere.
  it("puts a restored page in the default folder when its own folder is gone", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.trash.loading).toBe(false));

    let folderId = "";
    let pageId = "";
    await act(async () => {
      const folder = await hook.result.current.pages.createFolder({ name: "Doomed folder" });
      folderId = folder.id;
      const page = await hook.result.current.pages.createPage({ folderId, title: "Homeless" });
      pageId = page.id;
    });

    await act(async () => {
      await hook.result.current.pages.softDeleteFolder(folderId);
      await hook.result.current.pages.deleteFolder(folderId);
    });
    await act(async () => {
      await hook.result.current.trash.restore(pageId);
    });

    const restored = hook.result.current.pages.pages.find((p) => p.id === pageId);
    expect(restored).toBeDefined();
    expect(restored!.folderId).not.toBe(folderId);
    // No default folder is configured here, and the ladder's last rung is Inbox.
    expect(restored!.folderId).toBeNull();
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

  it("keeps the latest read when an earlier one lands after it", async () => {
    const hook = renderHookWithProviders(() => ({
      trash: useTrash(true),
      workspace: useWorkspace(),
    }));
    await waitFor(() => {
      expect(hook.result.current.workspace.storage).not.toBeNull();
      expect(hook.result.current.trash.loading).toBe(false);
    });
    const storage = hook.result.current.workspace.storage!;
    let landOld: (rows: TrashedPage[]) => void = () => undefined;
    const old = new Promise<TrashedPage[]>((resolve) => {
      landOld = resolve;
    });
    vi.spyOn(storage, "listTrashedPages").mockReturnValueOnce(old).mockResolvedValueOnce([]);

    await act(async () => {
      void hook.result.current.trash.refresh();
      await hook.result.current.trash.refresh();
    });
    await act(async () => {
      landOld([{ title: "destroyed" } as TrashedPage]);
      await old;
    });

    expect(hook.result.current.trash.entries).toEqual([]);
  });

  it("still says so when an empty fails, after the re-read that follows it succeeds", async () => {
    const hook = renderHookWithProviders(() => ({
      trash: useTrash(true),
      workspace: useWorkspace(),
    }));
    await waitFor(() => {
      expect(hook.result.current.workspace.storage).not.toBeNull();
      expect(hook.result.current.trash.loading).toBe(false);
    });
    const storage = hook.result.current.workspace.storage!;
    vi.spyOn(storage, "purgeTrashedPages").mockRejectedValueOnce(new Error("disk I/O error"));
    const read = vi.spyOn(storage, "listTrashedPages");

    await act(async () => {
      await hook.result.current.trash.emptyTrash();
    });

    expect(read).toHaveBeenCalled();
    expect(hook.result.current.trash.error).toBe("That didn't work. Try again.");
  });
});
