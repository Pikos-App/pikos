// Bridges Tauri's native drag-drop event to the active Tiptap editor.
// macOS WKWebView swallows HTML5 file drops from Finder, so ProseMirror's
// handleDrop never fires. We listen to onDragDropEvent at the window level
// and insert image nodes manually using posAtCoords for the drop location.

import type { Editor } from "@tiptap/react";

import { postNotice } from "@/shared/events/noticeBus";
import { createLogger } from "@/shared/logger";
import { getPlatform } from "@/shared/platform";

const log = createLogger("imageDropBridge");

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

let activeEditor: Editor | null = null;
let initialized = false;

function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext);
}

async function insertImageAt(editor: Editor, sourcePath: string, pos: number): Promise<number> {
  try {
    const savedPath = await getPlatform().saveAsset(sourcePath);
    const src = getPlatform().assetUrl(savedPath);
    const filename = sourcePath.split(/[\\/]/).pop() ?? "image";
    const { schema } = editor.view.state;
    const node = schema.nodes["image"]?.create({
      alt: filename.replace(/\.[^.]+$/, ""),
      "data-asset-path": savedPath,
      src,
    });
    if (!node) return pos;
    const tr = editor.view.state.tr.insert(pos, node);
    editor.view.dispatch(tr);
    return pos + node.nodeSize;
  } catch (e) {
    // Don't pass `e` directly — the Tauri command's error string can echo
    // the user's source path. Log only a fixed message + error class name.
    log.error("save_asset failed", e instanceof Error ? e.name : "unknown");
    postNotice("Couldn't save the image. Check disk space and permissions.");
    return pos;
  }
}

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await getPlatform().onNativeFileDrop((drop) => {
      const editor = activeEditor;
      if (!editor || editor.isDestroyed) return;
      const imagePaths = drop.paths.filter(isImagePath);
      if (imagePaths.length === 0) return;

      // The host reports physical pixels — convert to CSS px for posAtCoords.
      const dpr = window.devicePixelRatio || 1;
      const x = drop.position.x / dpr;
      const y = drop.position.y / dpr;

      const dom = editor.view.dom;
      const rect = dom.getBoundingClientRect();
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

      const startPos = inside
        ? (editor.view.posAtCoords({ left: x, top: y })?.pos ?? editor.state.selection.anchor)
        : editor.state.doc.content.size;

      void (async () => {
        let pos = startPos;
        for (const p of imagePaths) {
          pos = await insertImageAt(editor, p, pos);
        }
        editor.view.focus();
      })();
    });
  } catch (e) {
    // Host without native file drops (tests, marketing site) — bridge no-ops.
    log.warn("init skipped", e);
  }
}

export function registerActiveEditor(editor: Editor): () => void {
  activeEditor = editor;
  void init();
  return () => {
    if (activeEditor === editor) activeEditor = null;
  };
}
