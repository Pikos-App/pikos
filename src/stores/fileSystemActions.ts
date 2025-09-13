import { get } from "svelte/store";
import { pages, selectedFolder, selectedPage, type Page } from "./fileSystemStore";
import { remove, readTextFile, writeTextFile, readDir, type DirEntry } from "@tauri-apps/plugin-fs";

export interface FSAdapter {
  remove(path: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
}

let fs: FSAdapter = { remove, readTextFile, writeTextFile, readDir };

// allow for custom fs adapter for testing
export function setFSAdapter(adapter: FSAdapter) {
  fs = adapter;
}

// Automatically load content whenever the selected page changes
let __lastLoadedPath: string | null = null;
selectedPage.subscribe(async (p) => {
  const path = p?.path ?? null;
  if (!path) {
    __lastLoadedPath = null;
    return;
  }
  
  // Always update the selected page in the pages list to ensure consistency
  if (p) {
    pages.update(pages => 
      pages.map(page => 
        page.path === p.path ? { ...page, ...p } : page
      )
    );
  }
  
  // Only load content if it's a different page
  if (path !== __lastLoadedPath) {
    __lastLoadedPath = path;
    // Force a re-render by setting content to null first
    if (p) {
      selectedPage.set({ ...p, content: undefined });
    }
    // Then load the content
    await readPageContent(path);
  }
});

// Automatically load directory listing whenever the selected folder changes
let __lastLoadedFolderPath: string | null = null;
selectedFolder.subscribe((f) => {
  const path = f?.path ?? null;
  if (!path) {
    __lastLoadedFolderPath = null;
    pages.set([]);
    return;
  }
  if (path !== __lastLoadedFolderPath) {
    __lastLoadedFolderPath = path;
    // fire and forget; store will be updated by the action
    readDirectory(path);
  }
});

/**
 * Read content from a page's file and update in-memory stores.
 */
export async function readPageContent(path?: string) {
  const targetPath = path ?? get(selectedPage)?.path;
  if (!targetPath) return;

  const start = performance.now();
  try {
    const text = await fs.readTextFile(targetPath);
    const fsMs = performance.now() - start;
    console.log(`[FS] readPageContent: file read in ${fsMs.toFixed(2)} ms for`, targetPath);

    // Update stores with loaded content
    pages.update((list) => {
      const updated = list.map((p) => 
        p.path === targetPath ? { ...p, content: text } : p
      );
      return updated;
    });

    // Always get the latest selectedPage to ensure we don't have a stale reference
    const currentPage = get(selectedPage);
    if (currentPage?.path === targetPath) {
      selectedPage.set({ ...currentPage, content: text });
    }

    return text;
  } catch (e) {
    console.error("Failed to read file:", e);
  }
}

/**
 * Read a directory and populate the pages store with directories and markdown files.
 * Directories are listed first, then files; both sorted alphabetically (case-insensitive).
 */
export async function readDirectory(dirPath?: string) {
  const folderPath = dirPath ?? get(selectedFolder)?.path;
  if (!folderPath) return;

  const start = performance.now();
  try {
    const entries = await fs.readDir(folderPath);

    const filtered = entries.filter((e) => {
      const isDir = e.isDirectory === true;
      const name = e.name ?? "";
      const isMd = !isDir && name.toLowerCase().endsWith(".md");
      return isDir || isMd;
    });

    filtered.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const an = (a.name ?? "").toLowerCase();
      const bn = (b.name ?? "").toLowerCase();
      return an.localeCompare(bn);
    });

    const list: Page[] = filtered.map((e) => {
      const is_directory = e.isDirectory === true;
      const name = e.name ?? "unknown";
      const path = (e as any).path ?? `${folderPath}/${name}`;
      const is_markdown = !is_directory && name.toLowerCase().endsWith(".md");
      return {
        id: path,
        title: name,
        path,
        isCompleted: false,
        scheduledAt: null,
        is_directory,
        is_markdown,
      } as Page;
    });

    pages.set(list);

    const ms = performance.now() - start;
    console.log(`[FS] readDirectory: loaded ${list.length} entries in ${ms.toFixed(2)} ms from`, folderPath);
    return list;
  } catch (e) {
    console.error("Failed to read directory:", e);
  }
}

/**
 * Persist content to a page's file, then update in-memory stores.
 */
export async function writePageContent(content: string, path?: string) {
  const current = get(selectedPage);
  const targetPath = path ?? current?.path;
  if (!targetPath) return;

  const start = performance.now();
  try {
    await fs.writeTextFile(targetPath, content);
    const fsMs = performance.now() - start;
    console.log(`[FS] writePageContent: file persisted in ${fsMs.toFixed(2)} ms for`, targetPath);

    const updatedAt = new Date().toISOString();
    pages.update((list) => list.map((p) => (p.path === targetPath ? { ...p, content: content, updatedAt } : p)));
    if (current?.path === targetPath) selectedPage.set({ ...current, content: content, updatedAt });
  } catch (e) {
    console.error("Failed to write file:", e);
  }
}

/**
 * Optimistically update stores with new content, then persist.
 * Revert stores if the filesystem write fails.
 */
export async function optimisticWritePageContent(contents: string, path?: string) {
  const current = get(selectedPage);
  const targetPath = path ?? current?.path;
  if (!targetPath) return;

  const prevPages = get(pages);
  const prevSelected = current;

  const updatedAt = new Date().toISOString();

  const start = performance.now();
  // optimistic state
  pages.update((list) => list.map((p) => (p.path === targetPath ? { ...p, content: contents, updatedAt } : p)));
  if (current?.path === targetPath) selectedPage.set({ ...current, content: contents, updatedAt });
  const optimisticMs = performance.now() - start;
  console.log(
    `[FS] optimisticWritePageContent: optimistic state updated in ${optimisticMs.toFixed(2)} ms for`,
    targetPath
  );

  try {
    const tWrite = performance.now();
    await fs.writeTextFile(targetPath, contents);
    const fsMs = performance.now() - tWrite;
    console.log(`[FS] optimisticWritePageContent: file persisted in ${fsMs.toFixed(2)} ms for`, targetPath);
  } catch (e) {
    // revert state
    pages.set(prevPages);
    selectedPage.set(prevSelected);
    const revertMs = performance.now() - start;
    console.warn(
      `[FS] optimisticWritePageContent: write failed after ${revertMs.toFixed(2)} ms, state reverted for`,
      targetPath
    );
    console.error("Failed to write file:", e);
  }
}

/**
 * Create a new untitled markdown file in the currently selected folder.
 * - Generates name like "untitled.md", "untitled 2.md", ... based on existing pages titles.
 */
export async function createFile() {
  const folder = get(selectedFolder);
  if (!folder) return;

  const nextUntitledNumber = getNextUntitledNumber();
  const newFileName = !nextUntitledNumber ? "untitled.md" : `untitled ${nextUntitledNumber}.md`;
  const newFilePath = folder.path + "/" + newFileName;

  const start = performance.now();
  try {
    console.log("[FS] createFile: selectedFolder=", folder.path);
    const beforeLen = get(pages).length;

    await fs.writeTextFile(newFilePath, "");
    const fsMs = performance.now() - start;
    console.log(`[FS] createFile: file created in ${fsMs.toFixed(2)} ms at`, newFilePath);

    const newPage: Page = {
      id: newFilePath,
      title: newFileName,
      path: newFilePath,
      isCompleted: false,
      scheduledAt: null,
      is_directory: false,
      is_markdown: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    console.log(`[FS] createFile: pages length before update: ${beforeLen}`);
    pages.update((list) => [newPage, ...list]);
    const afterLen = get(pages).length;
    console.log(`[FS] createFile: pages length after update: ${afterLen}`);
    selectedPage.set(newPage);
  } catch (error) {
    console.error("Failed to create file:", error);
  }
}

function getNextUntitledNumber(): number {
  const list = get(pages);
  if (!list.length) return 0;

  const used = new Set<number>();
  for (const p of list) {
    const title = p.title?.trim() ?? "";
    if (title.toLowerCase() === "untitled.md") {
      used.add(0);
      continue;
    }
    const m = /^untitled\s*(\d+)\.md$/i.exec(title);
    if (m) used.add(parseInt(m[1], 10));
  }

  // find the smallest non-negative integer not in used
  let n = 0;
  while (used.has(n)) n++;
  return n;
}

/**
 * Optimistically create a new file and update stores immediately.
 * Reverts state if the filesystem write fails.
 */
export async function optimisticCreateFile() {
  const folder = get(selectedFolder);
  if (!folder) return;

  const next = getNextUntitledNumber();
  const newFileName = next === 0 ? "untitled.md" : `untitled ${next}.md`;
  const newFilePath = folder.path + "/" + newFileName;

  const nowIso = new Date().toISOString();
  const newPage: Page = {
    id: newFilePath,
    title: newFileName,
    path: newFilePath,
    isCompleted: false,
    scheduledAt: null,
    is_directory: false,
    is_markdown: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const prevPages = get(pages);
  const prevSelected = get(selectedPage);

  const start = performance.now();
  pages.update((list) => [newPage, ...list]);
  selectedPage.set(newPage);
  const optimisticMs = performance.now() - start;
  console.log(`[FS] optimisticCreateFile: optimistic state updated in ${optimisticMs.toFixed(2)} ms for`, newFilePath);

  try {
    const tWrite = performance.now();
    await fs.writeTextFile(newFilePath, "");
    const fsMs = performance.now() - tWrite;
    console.log(`[FS] optimisticCreateFile: file persisted in ${fsMs.toFixed(2)} ms at`, newFilePath);
    return newPage;
  } catch (e) {
    // revert state
    pages.set(prevPages);
    selectedPage.set(prevSelected);
    const revertMs = performance.now() - start;
    console.warn(
      `[FS] optimisticCreateFile: write failed after ${revertMs.toFixed(2)} ms, state reverted for`,
      newFilePath
    );
    console.error("Failed to create file:", e);
  }
}

/**
 * Delete a page from the file system -
 * defaults to current page unless specified
 */
export async function deletePage(path?: string) {
  const current = get(selectedPage);
  const targetPath = path ?? current?.path;

  if (!targetPath) return;

  try {
    const start = performance.now();
    await fs.remove(targetPath);
    const deleteMs = performance.now() - start;
    console.log(`[FS] deletePage: deletion completed in ${deleteMs.toFixed(2)} ms for`, targetPath);

    if (current?.path === targetPath) selectedPage.set(null);

    pages.update((list) => list.filter((p) => p.path !== targetPath));
    const stateMs = performance.now() - start;
    console.log(`[FS] deletePage: state updated at ${stateMs.toFixed(2)} ms since invocation for`, targetPath);
  } catch (e) {
    console.error("Failed to delete file:", e);
  }
}

export async function optimisticDeletePage(path?: string) {
  const current = get(selectedPage);
  const targetPath = path ?? current?.path;

  if (!targetPath) return;

  const prevSelected = current;
  const prevPages = get(pages);

  // Optimistic update
  const start = performance.now();
  if (prevSelected?.path === targetPath) selectedPage.set(null);
  pages.update((list) => list.filter((p) => p.path !== targetPath));
  const optimisticStateMs = performance.now() - start;
  console.log(
    `[FS] optimisticDeletePage: optimistic state updated in ${optimisticStateMs.toFixed(2)} ms for`,
    targetPath
  );

  try {
    await fs.remove(targetPath);
    const deleteMs = performance.now() - start;
    console.log(`[FS] optimisticDeletePage: deletion completed in ${deleteMs.toFixed(2)} ms for`, targetPath);
  } catch (e) {
    // Revert on failure
    selectedPage.set(prevSelected);
    pages.set(prevPages);
    const revertMs = performance.now() - start;
    console.warn(
      `[FS] optimisticDeletePage: deletion failed after ${revertMs.toFixed(2)} ms, state reverted for`,
      targetPath
    );
    console.error("Failed to delete file:", e);
    // TODO: show a toast/snackbar
  }
}
