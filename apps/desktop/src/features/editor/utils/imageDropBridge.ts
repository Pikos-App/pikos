// Bridges Tauri's native drag-drop event to the active Tiptap editor.
// macOS WKWebView swallows HTML5 file drops from Finder, so ProseMirror's
// handleDrop never fires. We listen to onDragDropEvent at the window level
// and insert image nodes manually using posAtCoords for the drop location.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Editor } from "@tiptap/react";

import { postNotice } from "@/shared/events/noticeBus";
import { createLogger } from "@/shared/logger";

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
    const savedPath = await invoke<string>("save_asset", { sourcePath });
    const src = convertFileSrc(savedPath);
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
    const webview = getCurrentWebview();
    await webview.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const editor = activeEditor;
      if (!editor || editor.isDestroyed) return;
      const imagePaths = event.payload.paths.filter(isImagePath);
      if (imagePaths.length === 0) return;

      // Tauri reports physical pixels — convert to CSS pixels for posAtCoords.
      const dpr = window.devicePixelRatio || 1;
      const x = event.payload.position.x / dpr;
      const y = event.payload.position.y / dpr;

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
    // Non-Tauri env (tests, marketing site) — bridge becomes a no-op.
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
