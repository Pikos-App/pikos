// useImport — orchestrates the parse → mapping → preview → execute → undo flow for data import.

import { extractText } from "@pikos/core";
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
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
import type { CSVMappingConfig, ImageRef, ImportPlan } from "../parsers/types";
import { cleanTitle } from "../parsers/utils";

// ─── Markdown → Tiptap JSON conversion ───────────────────────────────────────

/**
 * Obsidian renders blank lines (\n\n) as visible empty lines the user can click on.
 * Standard markdown just uses them as paragraph separators with no intermediate content.
 * After converting markdown → Tiptap JSON, insert empty paragraph nodes between
 * top-level blocks to match Obsidian's visual behavior.
 *
 * For 3+ consecutive newlines (extra blank lines), additional empty paragraphs are added.
 */
export function insertBlankLineParagraphs(md: string, json: JSONContent): JSONContent {
  if (!json.content || json.content.length < 2) return json;

  // Count how many blank lines each \n\n+ separator represents.
  // Split the markdown by block separators, keeping separators.
  const separators: number[] = [];
  for (const m of md.matchAll(/\n{2,}/g)) {
    // \n\n = 1 blank line, \n\n\n = 2 blank lines, etc.
    separators.push(m[0].length - 1);
  }

  const newContent: JSONContent[] = [];
  for (let i = 0; i < json.content.length; i++) {
    newContent.push(json.content[i]!);

    // Insert empty paragraphs after each node (except the last)
    if (i < json.content.length - 1) {
      const blankLines = separators[i] ?? 1;
      for (let j = 0; j < blankLines; j++) {
        newContent.push({ type: "paragraph" });
      }
    }
  }

  return { ...json, content: newContent };
}

let cachedConvert: ((md: string) => string) | null = null;

function getMarkdownConverter(): (md: string) => string {
  if (cachedConvert) return cachedConvert;
  cachedConvert = convertMarkdownToTiptap;
  return cachedConvert;
}

/** Convert an Obsidian markdown string to a Tiptap JSON string. */
export function convertMarkdownToTiptap(md: string): string {
  // Lazy-init a single editor instance for the lifetime of the app.
  if (!sharedEditor) {
    sharedEditor = new Editor({
      content: "",
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Underline,
        Image.configure({ allowBase64: false, inline: false }),
        Table.configure({ resizable: false }),
        TableRow,
        TableCell,
        TableHeader,
        Markdown.configure({
          // Obsidian renders single \n as line breaks (non-CommonMark).
          // Without this, single newlines collapse to spaces.
          breaks: true,
          transformPastedText: false,
        }),
      ],
    });
  }

  sharedEditor.commands.setContent(md);
  return JSON.stringify(insertBlankLineParagraphs(md, sharedEditor.getJSON()));
}

let sharedEditor: Editor | null = null;

function wrapPlainText(text: string): string {
  if (!text) return JSON.stringify({ content: [], type: "doc" });
  const paragraphs = text.split("\n").map((line) => ({
    content: line ? [{ text: line, type: "text" }] : [],
    type: "paragraph",
  }));
  return JSON.stringify({ content: paragraphs, type: "doc" });
}

// ─── Image import helpers ────────────────────────────────────────────────────

/**
 * Resolve image references in a markdown body, copy files to workspace assets,
 * and rewrite the body with the saved absolute paths.
 * Returns the rewritten body and any warnings.
 */
async function resolveImportImages(
  body: string,
  imageRefs: ImageRef[],
  vaultRoot: string
): Promise<{ body: string; warnings: string[] }> {
  if (imageRefs.length === 0) return { body, warnings: [] };

  const warnings: string[] = [];
  let rewritten = body;

  // Deduplicate by sourcePath — same image referenced multiple times should copy once
  const pathToSaved = new Map<string, string>();

  for (const ref of imageRefs) {
    // Skip if we already processed this source path
    if (pathToSaved.has(ref.sourcePath)) {
      const savedPath = pathToSaved.get(ref.sourcePath)!;
      rewritten = rewriteImageRef(rewritten, ref, savedPath);
      continue;
    }

    // Resolve relative to vault root
    const sep = vaultRoot.endsWith("/") ? "" : "/";
    const basePath = `${vaultRoot}${sep}${ref.sourcePath}`;

    // Try the path as-is first, then with common image extensions (Obsidian
    // allows extensionless embeds like ![[Screenshot 2026-04-13 at 7.41.23 PM]])
    const hasExt = /\.\w+$/.test(ref.sourcePath);
    const candidates = hasExt
      ? [basePath]
      : [basePath, ...["png", "jpg", "jpeg", "gif", "webp", "svg"].map((e) => `${basePath}.${e}`)];

    let saved = false;
    for (const candidate of candidates) {
      try {
        const savedPath = await invoke<string>("save_asset", { sourcePath: candidate });
        pathToSaved.set(ref.sourcePath, savedPath);
        rewritten = rewriteImageRef(rewritten, ref, savedPath);
        saved = true;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!saved) {
      if (ref.speculative) {
        // Speculative ref (extensionless wiki-embed) — leave as-is in the body.
        // It's probably a note transclusion, not an image.
      } else {
        // Definite image ref that couldn't be resolved — warn and strip
        warnings.push(`Image not found: ${ref.sourcePath}`);
        rewritten = rewritten.replace(ref.fullMatch, "");
      }
    }
  }

  return { body: rewritten, warnings };
}

/** Rewrite a single image reference in the markdown body. */
function rewriteImageRef(body: string, ref: ImageRef, savedPath: string): string {
  // Angle brackets handle spaces in paths (e.g. "Application Support")
  const replacement = `![${ref.altText}](<${savedPath}>)`;
  return body.replace(ref.fullMatch, replacement);
}

/** Walk Tiptap JSON and add data-asset-path to image nodes that have local src. */
function addAssetPathsToJson(json: JSONContent): JSONContent {
  if (json.type === "image" && json.attrs?.["src"]) {
    const src = json.attrs["src"] as string;
    // If src looks like an absolute filesystem path, set it as data-asset-path.
    // Decode URI encoding (tiptap-markdown encodes spaces as %20) so the
    // path matches the actual filesystem.
    if (src.startsWith("/") && !src.startsWith("//")) {
      const decodedSrc = decodeURIComponent(src);
      return {
        ...json,
        attrs: { ...json.attrs, "data-asset-path": decodedSrc, src: decodedSrc },
      };
    }
  }

  if (json.content) {
    return {
      ...json,
      content: json.content.map(addAssetPathsToJson),
    };
  }

  return json;
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
      plan.vaultRoot = dirPath;
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

      // Build batch items — process images for markdown imports
      const batchPages: ImportBatchItem[] = [];
      for (const p of plan.pages) {
        let bodyToConvert = p.body;

        // Resolve and copy images if this is a markdown import with image refs
        if (p.imageRefs.length > 0 && plan.vaultRoot) {
          const result = await resolveImportImages(bodyToConvert, p.imageRefs, plan.vaultRoot);
          bodyToConvert = result.body;
          // Image warnings are informational — don't block import
        }

        const rawContent = bodyToConvert ? convert(bodyToConvert) : wrapPlainText("");
        // Add data-asset-path to image nodes so export can find the files
        const parsed = addAssetPathsToJson(JSON.parse(rawContent) as JSONContent);
        const content = JSON.stringify(parsed);
        const contentText = extractText(parsed);

        batchPages.push({
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
        });
      }

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
