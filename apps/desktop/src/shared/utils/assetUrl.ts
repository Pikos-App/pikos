import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Resolve a workspace asset path to a URL the webview can load.
 *
 * Tauri serves local files through its own protocol; a bare filesystem path in an `<img src>`
 * resolves to nothing. Lives in shared/ because both the editor and the importer need it, and the
 * importer reaching into the editor's feature directory is the coupling the dependency rules
 * prevent. Mobile resolves through a custom URL scheme behind the same `ResolveAssetUrl` in
 * @pikos/editor-schema, which is why the schema takes the resolver as a parameter.
 */
export function assetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}
