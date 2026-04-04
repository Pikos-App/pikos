// useImport — orchestrates the parse → mapping → preview → execute → undo flow for data import.

import { extractText } from "@pikos/core";
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { Editor } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { useState } from "react";
import { Markdown } from "tiptap-markdown";

import type { ImportBatchItem } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  applyMappings,
  detectUniqueValues,
  prepareCSVRows,
  suggestColumnMappings,
  suggestValueMappings,
} from "../parsers/csv";
import { parseMarkdownVault, type VaultFile } from "../parsers/markdown";
import type { CSVMappingConfig, ImportPlan } from "../parsers/types";
import { cleanTitle } from "../parsers/utils";

// ─── Markdown → Tiptap JSON conversion ───────────────────────────────────────

let cachedConvert: ((md: string) => string) | null = null;

function getMarkdownConverter(): (md: string) => string {
  if (cachedConvert) return cachedConvert;

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

interface VaultReadResult {
  files: VaultFile[];
  skipped: { count: number; reason: string }[];
}

async function readVaultFiles(dirPath: string): Promise<VaultReadResult> {
  const files: VaultFile[] = [];
  let excalidrawCount = 0;
  let otherCount = 0;

  async function walk(path: string, prefix: string): Promise<void> {
    const entries = await readDir(path);
    for (const entry of entries) {
      const fullPath = `${path}/${entry.name}`;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        if (entry.name.startsWith(".")) continue;
        await walk(fullPath, relativePath);
      } else if (
        entry.name.toLowerCase().endsWith(".excalidraw.md") ||
        entry.name.toLowerCase().endsWith(".excalidraw")
      ) {
        excalidrawCount++;
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        const content = await readTextFile(fullPath);
        files.push({ content, path: relativePath });
      } else if (!entry.name.startsWith(".")) {
        otherCount++;
      }
    }
  }

  await walk(dirPath, "");

  const skipped: { count: number; reason: string }[] = [];
  if (excalidrawCount > 0) skipped.push({ count: excalidrawCount, reason: "Excalidraw drawings" });
  if (otherCount > 0)
    skipped.push({ count: otherCount, reason: "non-Markdown files (images, PDFs, etc.)" });

  return { files, skipped };
}

// ─── State machine ────────────────────────────────────────────────────────────

export type ImportState =
  | { step: "idle" }
  | { step: "parsing" }
  | {
      step: "mapping";
      rows: Record<string, string>[];
      headers: string[];
      initialConfig: CSVMappingConfig;
    }
  | { step: "preview"; plan: ImportPlan }
  | { step: "importing" }
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
      const { files, skipped } = await readVaultFiles(dirPath);
      if (files.length === 0) {
        setState({ message: "No .md files found in the selected folder.", step: "error" });
        return;
      }
      const plan = parseMarkdownVault(files);
      plan.meta.skipped.push(...skipped);
      setState({ plan, step: "preview" });
    } catch (e) {
      setState({ message: String(e), step: "error" });
    }
  }

  function parseCSVFile(content: string) {
    setState({ step: "parsing" });
    try {
      const { headers, rows } = prepareCSVRows(content);
      if (rows.length === 0) {
        setState({ message: "CSV file is empty or has no data rows.", step: "error" });
        return;
      }
      const { detectedSource, mappings } = suggestColumnMappings(headers, rows);

      // Pre-generate value mappings for auto-detected status/priority columns
      const initialValueMappings: CSVMappingConfig["valueMappings"] = [];
      for (const cm of mappings) {
        if (cm.pikosField === "status" || cm.pikosField === "priority") {
          const uniqueVals = detectUniqueValues(rows, cm.csvHeader);
          if (uniqueVals.length > 0) {
            initialValueMappings.push(
              suggestValueMappings(cm.pikosField, uniqueVals, detectedSource)
            );
          }
        }
      }

      const initialConfig: CSVMappingConfig = {
        columnMappings: mappings,
        detectedSource,
        valueMappings: initialValueMappings,
      };
      setState({ headers, initialConfig, rows, step: "mapping" });
    } catch (e) {
      setState({ message: String(e), step: "error" });
    }
  }

  function applyCSVMapping(config: CSVMappingConfig) {
    if (state.step !== "mapping") return;
    try {
      const plan = applyMappings(state.rows, config);
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
    setState({ step: "importing" });

    try {
      // Pre-import backup (non-blocking — don't fail the import if backup fails)
      try {
        await invoke("backup_db_before_import");
      } catch {
        // Best-effort backup — continue with import
      }

      // Convert content to Tiptap JSON — use markdown converter for all sources
      // (handles plain CSV bodies as single paragraphs).
      const convert = getMarkdownConverter();

      // Build batch items
      const batchPages: ImportBatchItem[] = plan.pages.map((p) => {
        const content = p.body ? convert(p.body) : wrapPlainText("");
        const parsed = JSON.parse(content);
        const contentText = extractText(parsed);

        return {
          completedAt: p.completedAt,
          content,
          contentText,
          createdAt: p.createdAt,
          folderKey: p.folderKey,
          priority: p.priority,
          reminderMinutes: p.reminderMinutes,
          scheduledEnd: p.scheduledEnd,
          scheduledStart: p.scheduledStart,
          sourceId: p.sourceId,
          sourceParentId: p.sourceParentId,
          status: p.status,
          tags: p.tags,
          title: cleanTitle(p.title),
          updatedAt: p.updatedAt,
        };
      });

      const result = await importBatch({
        batchTag,
        folders: plan.folders,
        pages: batchPages,
        source: plan.source,
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
    await Promise.all(pageIds.map((id) => softDeletePage(id)));
    await Promise.all(folderIds.map((id) => softDeleteFolder(id)));
    setState({ step: "idle" });
  }

  return {
    applyCSVMapping,
    executeImport,
    parseCSVFile,
    parseMarkdownDir,
    reset,
    state,
    undoImport,
  };
}
