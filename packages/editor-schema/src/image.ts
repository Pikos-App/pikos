import Image from "@tiptap/extension-image";

/**
 * Resolves a stored asset path to a URL this platform's webview can load. It is a parameter
 * because Tauri rewrites to its `asset://` protocol and a WKWebView needs a custom scheme
 * handler.
 */
export type ResolveAssetUrl = (path: string) => string;

/**
 * The image node's schema: which attributes exist and their defaults. It must match across
 * platforms byte-for-byte because `getJSON()` serialises attributes verbatim; rendering is
 * layered on with `.extend()`.
 *
 * `data-asset-path` is the durable reference. `src` is derived from it at render time, since
 * an absolute `asset://` or custom-scheme URL means nothing on the other device.
 */
export function createPikosImageNode(resolveAssetUrl: ResolveAssetUrl) {
  return Image.extend({
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
            if (path) {
              src = resolveAssetUrl(path);
            } else if (src && !src.startsWith("http") && !src.startsWith("blob:")) {
              src = resolveAssetUrl(src);
            }
            return { src };
          },
        },
      };
    },
  });
}
