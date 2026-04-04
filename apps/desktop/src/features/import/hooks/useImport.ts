// useImport — orchestrates the parse → preview → execute → undo flow for data import.

import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { useState } from "react";

import type { ImportBatchItem } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { parseCSVImport } from "../parsers/csv";
import { parseMarkdownVault, type VaultFile } from "../parsers/markdown";
import type { ImportPlan } from "../parsers/types";

// ─── Markdown → Tiptap JSON conversion ───────────────────────────────────────

let cachedConvert: ((md: string) => string) | null = null;

async function getMarkdownConverter(): Promise<(md: string) => string> {
  if (cachedConvert) return cachedConvert;

  // Lazy-load Tiptap to avoid pulling it into the initial bundle
  const [
    { Editor },
    { default: StarterKit },
    { default: TaskList },
    { default: TaskItem },
    { default: Underline },
    { Markdown },
  ] = await Promise.all([
    import("@tiptap/core"),
    import("@tiptap/starter-kit"),
    import("@tiptap/extension-task-list"),
    import("@tiptap/extension-task-item"),
    import("@tiptap/extension-underline"),
    import("tiptap-markdown"),
  ]);

  const editor = new Editor({
    content: "",
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Underline,
      Markdown.configure({ transformPastedText: false }),
    ],
  });

  cachedConvert = (md: string): string => {
    editor.commands.setContent(md);
    return JSON.stringify(editor.getJSON());
  };

  return cachedConvert;
}

function wrapPlainText(text: string): string {
  if (!text) return JSON.stringify({ content: [], type: "doc" });
  const paragraphs = text.split("\n").map((line) => ({
    content: line ? [{ text: line, type: "text" }] : [],
    type: "paragraph",
  }));
  return JSON.stringify({ content: paragraphs, type: "doc" });
}

// ─── File reading ─────────────────────────────────────────────────────────────

async function readVaultFiles(dirPath: string): Promise<VaultFile[]> {
  const files: VaultFile[] = [];

  async function walk(path: string, prefix: string): Promise<void> {
    const entries = await readDir(path);
    for (const entry of entries) {
      const fullPath = `${path}/${entry.name}`;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        // Skip hidden directories (like .obsidian, .git)
        if (entry.name.startsWith(".")) continue;
        await walk(fullPath, relativePath);
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        const content = await readTextFile(fullPath);
        files.push({ content, path: relativePath });
      }
    }
  }

  await walk(dirPath, "");
  return files;
}

// ─── State machine ────────────────────────────────────────────────────────────

export type ImportState =
  | { step: "idle" }
  | { step: "parsing" }
  | { step: "preview"; plan: ImportPlan }
  | { step: "importing"; plan: ImportPlan; progress: number; total: number }
  | {
      step: "done";
      pageCount: number;
      folderCount: number;
      batchTag: string;
      pageIds: string[];
      folderIds: string[];
    }
  | { step: "error"; message: string };

export function useImport() {
  const [state, setState] = useState<ImportState>({ step: "idle" });
  const { importBatch, softDeleteFolder, softDeletePage } = useWorkspace();

  function reset() {
    setState({ step: "idle" });
  }

  async function parseMarkdownDir(dirPath: string) {
    setState({ step: "parsing" });
    try {
      const files = await readVaultFiles(dirPath);
      if (files.length === 0) {
        setState({ message: "No .md files found in the selected folder.", step: "error" });
        return;
      }
      const plan = parseMarkdownVault(files);
      setState({ plan, step: "preview" });
    } catch (e) {
      setState({ message: String(e), step: "error" });
    }
  }

  function parseCSVFile(content: string) {
    setState({ step: "parsing" });
    try {
      const plan = parseCSVImport(content);
      if (plan.pages.length === 0 && plan.warnings.length > 0) {
        setState({ message: plan.warnings[0]!.message, step: "error" });
        return;
      }
      setState({ plan, step: "preview" });
    } catch (e) {
      setState({ message: String(e), step: "error" });
    }
  }

  async function executeImport(plan: ImportPlan) {
    const batchTag = `_import_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "_")}`;
    const total = plan.pages.length;
    setState({ plan, progress: 0, step: "importing", total });

    try {
      // Pre-import backup (non-blocking — don't fail the import if backup fails)
      try {
        await invoke("backup_db_before_import");
      } catch {
        // Best-effort backup — continue with import
      }

      // Convert markdown content to Tiptap JSON
      const isMarkdown = plan.source === "markdown";
      let convert: ((md: string) => string) | null = null;
      if (isMarkdown) {
        convert = await getMarkdownConverter();
      }

      // Build batch items
      const batchPages: ImportBatchItem[] = plan.pages.map((p, i) => {
        // Update progress
        setState((prev) => (prev.step === "importing" ? { ...prev, progress: i } : prev));

        const content = isMarkdown && convert ? convert(p.body) : wrapPlainText(p.body);
        const completedAt = p.status === "done" ? new Date().toISOString() : null;

        return {
          completedAt,
          content,
          createdAt: p.createdAt,
          folderKey: p.folderKey,
          priority: p.priority,
          scheduledDate: p.scheduledDate,
          status: p.status,
          tags: p.tags,
          title: p.title,
        };
      });

      const result = await importBatch({
        batchTag,
        folders: plan.folders,
        pages: batchPages,
      });

      setState({
        batchTag,
        folderCount: result.folderIds.length,
        folderIds: result.folderIds,
        pageCount: plan.pages.length,
        pageIds: result.pageIds,
        step: "done",
      });
    } catch (e) {
      setState({ message: String(e), step: "error" });
    }
  }

  async function undoImport(pageIds: string[], folderIds: string[]) {
    // Soft-delete all imported pages, then empty folders
    for (const id of pageIds) {
      await softDeletePage(id);
    }
    for (const id of folderIds) {
      await softDeleteFolder(id);
    }
    setState({ step: "idle" });
  }

  return {
    executeImport,
    parseCSVFile,
    parseMarkdownDir,
    reset,
    state,
    undoImport,
  };
}
