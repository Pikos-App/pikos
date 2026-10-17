import { resolveAssetPath } from "@pikos/core";

/**
 * Assets are served by a custom WKURLSchemeHandler registered by the host.
 *
 * A custom scheme rather than file:// because WKWebView treats file:// as a
 * distinct, heavily restricted origin — loading the editor from one and images
 * from another runs into cross-origin rules that have no workaround worth
 * having.
 */
const ASSET_SCHEME = "pikos-asset";

/** Stands in for the assets folder, which the host's scheme handler roots every request at. */
const ASSETS_ROOT = "\u0000";

/** A stored image path as a request for a file inside the assets folder. A bare file name is
 *  what this editor stored before pages took the desktop's `assets/<file>`. */
export function resolveAssetUrl(path: string): string {
  const resolved = resolveAssetPath(path, ASSETS_ROOT);
  const name = resolved.startsWith(`${ASSETS_ROOT}/`)
    ? resolved.slice(ASSETS_ROOT.length + 1)
    : path;
  return `${ASSET_SCHEME}://asset/${encodeURI(name)}`;
}
