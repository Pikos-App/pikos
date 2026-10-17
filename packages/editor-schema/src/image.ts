import Image from "@tiptap/extension-image";

/**
 * Resolves a stored asset path to a URL this platform's webview can load.
 *
 * The two platforms answer this completely differently — Tauri rewrites to its
 * `asset://` protocol, and a WKWebView needs a custom scheme handler — which is
 * exactly why it is a parameter rather than an import. Everything else about
 * the image node is identical on both, and has to be: the attribute set is what
 * ends up in the stored document.
 */
export type ResolveAssetUrl = (path: string) => string;

/**
 * The image node's *schema*: which attributes exist and what they default to.
 *
 * This is the half that must match across platforms byte-for-byte, because
 * `getJSON()` serialises attributes verbatim. The rendering half — node views,
 * drop handling, upload — is platform-specific and layered on top with
 * `.extend()`, so desktop keeps its Tauri file handling and mobile can do
 * something entirely different without either touching the document format.
 *
 * `data-asset-path` is the durable reference. `src` is derived from it at
 * render time and is deliberately *not* the source of truth: an absolute
 * `asset://` or custom-scheme URL is meaningless on the other device, so
 * storing one would produce documents that only resolve where they were
 * written.
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
