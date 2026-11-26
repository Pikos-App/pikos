import { resolveAssetPath } from "@pikos/core";

/** A custom scheme rather than file://, which WKWebView treats as a restricted origin. */
const ASSET_SCHEME = "pikos-asset";

/** Stands in for the assets folder, which the host's scheme handler roots every request at. */
const ASSETS_ROOT = "\u0000";

/** A stored image path as a request for a file in the assets folder. A bare file name is also valid. */
export function resolveAssetUrl(path: string): string {
  const resolved = resolveAssetPath(path, ASSETS_ROOT);
  const name = resolved.startsWith(`${ASSETS_ROOT}/`)
    ? resolved.slice(ASSETS_ROOT.length + 1)
    : path;
  return `${ASSET_SCHEME}://asset/${encodeURI(name)}`;
}
