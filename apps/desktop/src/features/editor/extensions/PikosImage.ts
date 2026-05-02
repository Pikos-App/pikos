// PikosImage — Custom Tiptap Image extension that resolves local asset paths
// via Tauri's convertFileSrc for display, and handles drop/paste/file-picker uploads.

import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";
import Image from "@tiptap/extension-image";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { createLogger } from "@/shared/logger";

const log = createLogger("PikosImage");

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext);
}

/** Upload a file from a filesystem path via the save_asset Rust command. */
async function uploadFromPath(path: string): Promise<string> {
  return invoke<string>("save_asset", { sourcePath: path });
}

/** Upload raw image bytes (e.g. from clipboard paste). */
async function uploadFromBytes(data: Uint8Array, ext: string): Promise<string> {
  return invoke<string>("save_asset_bytes", { data: Array.from(data), ext });
}

/** Convert an absolute asset path to a webview-loadable URL. */
function assetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}

/** Handle file drop/paste — upload and insert image nodes. */
async function handleFiles(files: File[], view: EditorView, pos?: number): Promise<boolean> {
  const imageFiles = files.filter((f) => f.type.startsWith("image/") || isImageFile(f.name));
  if (imageFiles.length === 0) return false;

  for (const file of imageFiles) {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    try {
      const savedPath = await uploadFromBytes(bytes, ext);
      const src = assetUrl(savedPath);

      const { schema } = view.state;
      const node = schema.nodes["image"]?.create({
        alt: file.name.replace(/\.[^.]+$/, ""),
        // Store the absolute path as data attribute for export
        "data-asset-path": savedPath,
        src,
      });

      if (node) {
        const insertPos = pos ?? view.state.selection.anchor;
        const tr = view.state.tr.insert(insertPos, node);
        view.dispatch(tr);
      }
    } catch (e) {
      // Tauri command error may echo the user's source path. Log class only.
      log.error("Failed to save asset", e instanceof Error ? e.name : "unknown");
    }
  }

  return true;
}

const pikosImagePluginKey = new PluginKey("pikosImage");

export const PikosImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "data-asset-path": {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-asset-path"),
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes["data-asset-path"]) return {};
          return { "data-asset-path": attributes["data-asset-path"] };
        },
      },
      src: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("src"),
        renderHTML: (attributes: Record<string, unknown>) => {
          let src = (attributes["src"] as string) ?? "";
          const path = attributes["data-asset-path"] as string | null;
          // Resolve local asset paths to webview-loadable URLs
          if (path) {
            src = assetUrl(path);
          } else if (src && !src.startsWith("http") && !src.startsWith("blob:")) {
            src = assetUrl(src);
          }
          return { src };
        },
      },
    };
  },

  addNodeView() {
    return ({ node }: { node: { attrs: Record<string, unknown> } }) => {
      const dom = document.createElement("div");
      dom.classList.add("pikos-image-wrapper");

      const img = document.createElement("img");

      let src = (node.attrs["src"] as string) ?? "";
      const path = node.attrs["data-asset-path"] as string | null;
      if (path) {
        src = assetUrl(path);
      } else if (src && !src.startsWith("http") && !src.startsWith("blob:")) {
        src = assetUrl(src);
      }

      img.src = src;
      img.alt = (node.attrs["alt"] as string) ?? "";
      if (node.attrs["title"]) {
        img.title = node.attrs["title"] as string;
      }

      dom.appendChild(img);

      return {
        deselectNode() {
          dom.classList.remove("pikos-image-selected");
        },
        dom,
        selectNode() {
          dom.classList.add("pikos-image-selected");
        },
        stopEvent: (event: Event) => {
          // Block double-click and select events to prevent text selection inside image
          return event.type === "dblclick" || event.type === "selectstart";
        },
      };
    };
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? [];

    return [
      ...parentPlugins,
      new Plugin({
        key: pikosImagePluginKey,
        props: {
          handleDrop(view, event) {
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return false;

            const imageFiles = Array.from(files).filter(
              (f) => f.type.startsWith("image/") || isImageFile(f.name)
            );
            if (imageFiles.length === 0) return false;

            event.preventDefault();
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void handleFiles(imageFiles, view, pos);
            return true;
          },

          handlePaste(view, event) {
            const items = event.clipboardData?.items;
            if (!items) return false;

            const imageItems: File[] = [];
            for (const item of Array.from(items)) {
              if (item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) imageItems.push(file);
              }
            }

            if (imageItems.length === 0) return false;

            event.preventDefault();
            void handleFiles(imageItems, view);
            return true;
          },
        },
      }),
    ];
  },
});

/** Open a file dialog and insert the selected image. */
export async function insertImageFromDialog(view: EditorView): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    filters: [
      {
        extensions: IMAGE_EXTENSIONS,
        name: "Images",
      },
    ],
    multiple: false,
    title: "Select an image",
  });

  if (!selected) return;

  // open() returns string | string[] | null
  const filePath = typeof selected === "string" ? selected : selected[0];
  if (!filePath) return;

  try {
    const savedPath = await uploadFromPath(filePath);
    const src = assetUrl(savedPath);
    const filename = filePath.split("/").pop() ?? "image";

    const { schema } = view.state;
    const node = schema.nodes["image"]?.create({
      alt: filename.replace(/\.[^.]+$/, ""),
      "data-asset-path": savedPath,
      src,
    });

    if (node) {
      const { anchor } = view.state.selection;
      const tr = view.state.tr.insert(anchor, node);
      view.dispatch(tr);
    }
  } catch (e) {
    // Tauri command error may echo the user's source path. Log class only.
    log.error("Failed to upload from dialog", e instanceof Error ? e.name : "unknown");
  }
}
