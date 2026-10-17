import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Resolve a workspace asset path to a URL the webview can load.
 *
 * Tauri serves local files through its own protocol; a bare filesystem path in
 * an `<img src>` resolves to nothing. Lives in shared/ rather than alongside
 * the editor because both the editor and the importer need it, and the
 * importer reaching into the editor's feature directory is exactly the coupling
 * the dependency rules exist to prevent.
 *
 * The mobile equivalent is a custom URL scheme — see
 * `EditorAssetSchemeHandler`. Both sit behind `ResolveAssetUrl` in
 * @pikos/editor-schema, which is why the shared schema takes the resolver as a
 * parameter rather than importing one.
 */
export function assetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}
