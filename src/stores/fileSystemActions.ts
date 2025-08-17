import { get } from "svelte/store";
import { pages, selectedFolder, selectedPage, type Page } from "./fileSystemStore";
import { remove, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export interface FSAdapter {
  remove(path: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
}

let fs: FSAdapter = { remove, readTextFile, writeTextFile };

// allow for custom fs adapter for testing
export function setFSAdapter(adapter: FSAdapter) {
  fs = adapter;
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
  console.log(
    `[FS] optimisticCreateFile: optimistic state updated in ${optimisticMs.toFixed(2)} ms for`,
    newFilePath
  );

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
