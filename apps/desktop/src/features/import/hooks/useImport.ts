import type {
  CSVMappingConfig,
  ImageRef,
  ImportPage,
  ImportPlan,
  StorageAdapter,
  TitledPage,
  VaultFile,
} from "@pikos/core";
import {
  applyMappings,
  ASSET_DIR,
  bodyWithTitleLinks,
  cleanTitle,
  detectUniqueValues,
  imageRefCandidates,
  importLinkResolver,
  parseMarkdownVault,
  prepareCSVRows,
  resolveWikilinks,
  storageErrorUserMessage,
  suggestColumnMappings,
  suggestValueMappings,
  toStorageError,
  wikilinkTitles,
} from "@pikos/core";
import { createDocumentExtensions, Markdown } from "@pikos/editor-schema";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { useState } from "react";

import { useImportBatch } from "@/shared/context/ImportContext";
import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";
import { getPlatform } from "@/shared/platform";
import { EMPTY_TIPTAP_DOC, tryParseTiptapJson } from "@/shared/utils/jsonContent";

const log = createLogger("useImport");

import type { ImportBatchItem } from "../types";

/**
 * Inserts empty paragraphs between top-level blocks to match Obsidian, which renders each blank line
 * as a clickable empty line; standard markdown treats blank lines as separators only.
 */
export function insertBlankLineParagraphs(md: string, json: JSONContent): JSONContent {
  if (!json.content || json.content.length < 2) return json;

  const separators: number[] = [];
  for (const m of md.matchAll(/\n{2,}/g)) {
    // \n\n = 1 blank line, \n\n\n = 2 blank lines, etc.
    separators.push(m[0].length - 1);
  }

  const newContent: JSONContent[] = [];
  for (let i = 0; i < json.content.length; i++) {
    newContent.push(json.content[i]!);

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

export function convertMarkdownToTiptap(md: string): string {
  if (!sharedEditor) {
    sharedEditor = new Editor({
      content: "",
      // The production schema, not a hand-rolled approximation: a separate extension list drifted
      // (no TabIndent), so imported documents lacked `indent: 0` and the first keystroke on an opened
      // import rewrote the whole document. Only the markdown parsing is overridden below.
      extensions: createDocumentExtensions({
        markdown: Markdown.configure({
          // Obsidian renders single \n as line breaks (non-CommonMark); without this they collapse to spaces.
          breaks: true,
          transformPastedText: false,
        }),
        resolveAssetUrl: (path) => getPlatform().assetUrl(path),
      }),
    });
  }

  sharedEditor.commands.setContent(md);
  const withBlankLines = insertBlankLineParagraphs(md, sharedEditor.getJSON());

  // Normalise through the editor a second time: insertBlankLineParagraphs builds attribute-less
  // paragraph nodes, and re-running setContent lets ProseMirror apply the defaults. Done here rather
  // than at the construction site, which would need updating whenever the schema gains an attribute,
  // and forgetting is silent.
  sharedEditor.commands.setContent(withBlankLines);
  return JSON.stringify(sharedEditor.getJSON());
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

/**
 * Resolve image references in a markdown body, copy files to workspace assets,
 * and rewrite the body with their stored paths. `missing` is each image path, as
 * written, that no candidate resolved; its reference is dropped from the body.
 */
export async function resolveImportImages(
  body: string,
  imageRefs: ImageRef[],
  vaultRoot: string
): Promise<{ body: string; missing: string[] }> {
  if (imageRefs.length === 0) return { body, missing: [] };

  const missing: string[] = [];
  let rewritten = body;

  // One copy per sourcePath, however often it is referenced.
  const pathToSaved = new Map<string, string>();

  for (const ref of imageRefs) {
    if (pathToSaved.has(ref.sourcePath)) {
      const savedPath = pathToSaved.get(ref.sourcePath)!;
      rewritten = rewriteImageRef(rewritten, ref, savedPath);
      continue;
    }

    const sep = vaultRoot.endsWith("/") ? "" : "/";
    // Each place the image may be as written first, then with common image extensions
    // (Obsidian allows extensionless embeds like ![[Screenshot 2026-04-13 at 7.41.23 PM]])
    const hasExt = /\.\w+$/.test(ref.sourcePath);
    const candidates = imageRefCandidates(ref).flatMap((inVault) => {
      const basePath = `${vaultRoot}${sep}${inVault}`;
      return hasExt
        ? [basePath]
        : [
            basePath,
            ...["png", "jpg", "jpeg", "gif", "webp", "svg"].map((e) => `${basePath}.${e}`),
          ];
    });

    let saved = false;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const savedPath = await getPlatform().saveAsset(candidate);
        pathToSaved.set(ref.sourcePath, savedPath);
        rewritten = rewriteImageRef(rewritten, ref, savedPath);
        saved = true;
        break;
      } catch (e) {
        // Try next candidate; only the last failure is logged, once none is left.
        lastError = e;
      }
    }

    if (!saved) {
      if (ref.speculative) {
        // Speculative ref (extensionless wiki-embed) — leave as-is in the body.
        // It's probably a note transclusion, not an image.
      } else {
        // The path is the person's file name, so only the error, which formatError keeps to its kind.
        log.warn("an image in the import couldn't be copied", toStorageError(lastError));
        missing.push(ref.sourcePath);
        rewritten = rewritten.replace(ref.fullMatch, "");
      }
    }
  }

  return { body: rewritten, missing };
}

function rewriteImageRef(body: string, ref: ImageRef, savedPath: string): string {
  // Angle brackets handle spaces in paths (e.g. "Application Support")
  const replacement = `![${ref.altText}](<${savedPath}>)`;
  return body.replace(ref.fullMatch, replacement);
}

function addAssetPathsToJson(json: JSONContent): JSONContent {
  if (json.type === "image" && json.attrs?.["src"]) {
    const src = json.attrs["src"] as string;
    // Decode the URI encoding tiptap-markdown applies (spaces as %20) so the path matches the filesystem.
    if (src.startsWith(`${ASSET_DIR}/`) || (src.startsWith("/") && !src.startsWith("//"))) {
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

/** The workspace's pages titled as one of `titles`, leaving out any title an imported page has,
 *  since an imported page wins it. */
async function workspacePagesTitled(
  storage: Pick<StorageAdapter, "searchPages">,
  titles: string[],
  imported: TitledPage[]
): Promise<TitledPage[]> {
  const importedTitles = new Set(imported.map(({ title }) => title.toLowerCase()));
  const wanted = [...new Set(titles.map((t) => t.toLowerCase()))].filter(
    (t) => !importedTitles.has(t)
  );

  const responses = await Promise.all(wanted.map((t) => storage.searchPages(t, true)));

  return responses.flatMap(({ results }, i) =>
    results
      .filter(({ title }) => title.toLowerCase() === wanted[i])
      .map(({ id, title }) => ({ id, title }))
  );
}

interface VaultReadResult {
  files: VaultFile[];
  skipped: { count: number; reason: string }[];
}

async function readVaultFiles(dirPath: string): Promise<VaultReadResult> {
  // Test-mode escape hatch: e2e injects a vault as { path, files } so this
  // helper doesn't need a real Tauri fs runtime to walk the directory.
  if (import.meta.env["VITE_TEST_MODE"] === "true") {
    const injected = (
      window as unknown as {
        __PIKOS_TEST_VAULT__?: { path: string; files: VaultFile[] };
      }
    ).__PIKOS_TEST_VAULT__;
    if (injected && injected.path === dirPath) {
      return { files: injected.files, skipped: [] };
    }
  }

  const files: VaultFile[] = [];
  let excalidrawCount = 0;
  let otherCount = 0;

  async function walk(path: string, prefix: string): Promise<void> {
    const entries = await getPlatform().readDir(path);
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
        const content = await getPlatform().readTextFile(fullPath);
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

export interface MissingImage {
  page: string;
  image: string;
}

/** What an import couldn't carry over: images it didn't find, and `[[links]]` left as text
 *  because no page, or more than one, has that title. */
export interface ImportShortfall {
  missingImages: MissingImage[];
  unlinkedLinks: number;
}

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
  | ({
      step: "done";
      pageCount: number;
      folderCount: number;
      pageIds: string[];
      folderIds: string[];
    } & ImportShortfall)
  | { step: "error"; message: string };

export function useImport() {
  const [state, setState] = useState<ImportState>({ step: "idle" });
  const { importBatch } = useImportBatch();
  const { softDeleteFolder, softDeletePage } = usePages();
  const { storage } = useWorkspace();

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
      // The fs plugin's error quotes the file path, which is a note's title: kind only.
      log.error("reading the Markdown vault failed", toStorageError(e));
      setState({
        message: storageErrorUserMessage(toStorageError(e), "reading your Markdown vault"),
        step: "error",
      });
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
      // Nothing here throws on bad input, so this is a bug in the parser, and its stack says where.
      log.error("parsing the CSV failed", e);
      setState({
        message: storageErrorUserMessage(toStorageError(e), "parsing your CSV"),
        step: "error",
      });
    }
  }

  function applyCSVMapping(config: CSVMappingConfig) {
    if (state.step !== "mapping") return;
    try {
      const plan = applyMappings(state.rows, config);
      const firstWarning = plan.warnings[0];
      if (plan.pages.length === 0 && firstWarning) {
        setState({ message: firstWarning.message, step: "error" });
        return;
      }
      setState({ plan, step: "preview" });
    } catch (e) {
      log.error("applying the CSV column mapping failed", e);
      setState({
        message: storageErrorUserMessage(toStorageError(e), "applying your column mapping"),
        step: "error",
      });
    }
  }

  /** Resolves to what the import couldn't carry over, or null when it failed. */
  async function executeImport(plan: ImportPlan): Promise<ImportShortfall | null> {
    setState({ step: "importing" });

    try {
      // Non-blocking: a failed backup must not fail the import.
      try {
        await storage?.backupBeforeImport();
      } catch (err) {
        // Logged so a missing backup file isn't a mystery on rollback.
        log.warn("pre-import backup failed; proceeding without rollback file", err);
      }

      // The markdown converter serves every source; plain CSV bodies become single paragraphs.
      const convert = getMarkdownConverter();

      const converted: { doc: JSONContent; page: ImportPage; title: string }[] = [];
      const missingImages: MissingImage[] = [];
      for (const p of plan.pages) {
        let bodyToConvert = bodyWithTitleLinks(p.title, p.body);
        const title = cleanTitle(p.title);

        if (p.imageRefs.length > 0 && plan.vaultRoot) {
          const result = await resolveImportImages(bodyToConvert, p.imageRefs, plan.vaultRoot);
          bodyToConvert = result.body;
          for (const image of result.missing) missingImages.push({ image, page: title });
        }

        const rawContent = bodyToConvert ? convert(bodyToConvert) : wrapPlainText("");
        // The converter's output is our own, so a parse failure means it regressed; log and fall back
        // so the rest of the import completes.
        const parsedRaw = tryParseTiptapJson(rawContent, "useImport.executeImport");
        const doc = addAssetPathsToJson(parsedRaw ?? EMPTY_TIPTAP_DOC);
        converted.push({ doc, page: p, title });
      }

      const imported = converted.map(({ title }) => ({ id: crypto.randomUUID(), title }));
      const linkedTitles = converted.flatMap(({ doc }) => wikilinkTitles(doc));
      const workspace = storage ? await workspacePagesTitled(storage, linkedTitles, imported) : [];
      const resolve = importLinkResolver(imported, workspace);
      let unlinkedLinks = 0;
      const resolveCounting = (title: string) => {
        const id = resolve(title);
        if (id === null) unlinkedLinks++;

        return id;
      };

      const batchPages = converted.map(
        ({ doc, page: p, title }, i): ImportBatchItem => ({
          completedAt: p.completedAt,
          content: JSON.stringify(resolveWikilinks(doc, resolveCounting)),
          createdAt: p.createdAt,
          folderKey: p.folderKey,
          id: imported[i]!.id,
          priority: p.priority,
          reminderMinutes: p.reminderMinutes,
          rrule: p.rrule,
          scheduledEnd: p.scheduledEnd,
          scheduledStart: p.scheduledStart,
          sourceId: p.sourceId,
          sourceParentId: p.sourceParentId,
          status: p.status,
          tags: p.tags,
          title,
          updatedAt: p.updatedAt,
        })
      );

      const result = await importBatch({
        folders: plan.folders,
        pages: batchPages,
        source: plan.source,
      });

      setState({
        folderCount: result.folderIds.length,
        folderIds: result.folderIds,
        missingImages,
        pageCount: plan.pages.length,
        pageIds: result.pageIds,
        step: "done",
        unlinkedLinks,
      });
      return { missingImages, unlinkedLinks };
    } catch (e) {
      // Surface the raw cause: only a generic message reaches the UI, so the logs are where a failure is diagnosed.
      log.error("import failed", e);
      setState({
        message: storageErrorUserMessage(toStorageError(e), "running the import"),
        step: "error",
      });
      return null;
    }
  }

  async function undoImport(pageIds: string[], folderIds: string[]) {
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
