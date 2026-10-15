/** The folder, beside the database, that holds every image a page embeds. */
export const ASSET_DIR = "assets";

/** The `<uuid>.<ext>` name Pikos gives every file it saves into {@link ASSET_DIR}. */
const PIKOS_ASSET_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

/**
 * The file a page's stored image path names, inside this machine's `assetsDir`.
 *
 * Pages store `assets/<file>`, so a workspace copied to another Mac, another user or
 * another build still finds its images. Images saved by earlier versions stored the
 * full path on the machine that saved them; one that ends in an assets folder and a
 * name Pikos generated is read as that file here, which heals those pages without
 * rewriting them. Any other path is not one Pikos saved and comes back unchanged.
 *
 * The desktop backend's `resolve_asset_path` runs the same rule against the same
 * table, `asset-paths.json`.
 */
export function resolveAssetPath(stored: string, assetsDir: string): string {
  const parts = stored.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? "";
  if (parts.length === 2 && parts[0] === ASSET_DIR) return `${assetsDir}/${name}`;
  const absolute = stored.startsWith("/") || /^[A-Za-z]:[\\/]/.test(stored);
  if (absolute && parts[parts.length - 2] === ASSET_DIR && PIKOS_ASSET_NAME.test(name)) {
    return `${assetsDir}/${name}`;
  }
  return stored;
}
