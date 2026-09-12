// @pikos/editor-schema — the Tiptap document schema, and nothing else.
//
// Every Pikos editor builds on this: the desktop app, the iOS webview, and the
// import round-trip tests. The point is narrow and load-bearing — a document
// written on one device must parse identically on the other, and that is
// decided entirely by which nodes and marks exist and what attributes they
// carry.
//
// The dividing question for anything new is the only one that matters:
// *would omitting this on one platform change what `getJSON()` produces?*
//
// That question does NOT map onto "is it a node or a mark". Two extensions here
// look purely behavioural and are not:
//
//   TabIndent  adds an `indent` attribute to paragraph and heading
//   Markdown   adds a `tight` attribute to bullet and ordered lists
//
// Both were initially classified as behaviour and left out, and a schema
// snapshot caught it. Had they shipped that way, every document edited on the
// phone would have silently lost its indentation and list tightness on the next
// desktop save — a data-loss bug that no amount of reading the extension names
// would have predicted.
//
// What genuinely does not belong here: placeholders, slash menus, smart-quote
// input rules, node views, drop handling. Those differ legitimately between a
// keyboard-driven desktop app and a thumb-driven phone, and none of them can
// change a stored document.
//
// When adding an extension, check the snapshot test rather than reasoning about
// the name.

import type { Extensions } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

import { createPikosImageNode, type ResolveAssetUrl } from "./image";
import { TabIndent } from "./tabIndent";
import { PikosTable } from "./table";

export { createPikosImageNode, PikosTable, TabIndent };
export {
  getIndentLevel,
  isCursorAtLineStart,
  setIndentForSelection,
} from "./tabIndent";
export type { ResolveAssetUrl };

export interface DocumentSchemaOptions {
  /** Platform-specific asset path → loadable URL. See `ResolveAssetUrl`. */
  resolveAssetUrl: ResolveAssetUrl;
  /**
   * Replaces the default image node.
   *
   * Every platform needs its own image *rendering* — desktop draws through
   * Tauri's asset protocol and handles file drops, a phone will do neither —
   * while the image *attributes* must stay identical. Pass
   * `createPikosImageNode(resolveAssetUrl).extend({ ... })` so the platform
   * half is layered on rather than replacing the schema half.
   *
   * This is an option rather than something callers splice into the returned
   * array because splicing means reassembling the list, and reassembling is
   * how two platforms end up with schemas that differ in a way nobody notices
   * until a document round-trips wrong.
   */
  image?: Extensions[number];
}

/**
 * The complete set of schema-bearing extensions, in a fixed order.
 *
 * Order matters for extensions that override one another's attributes, so it is
 * fixed here rather than left to each caller to reassemble — reassembling is
 * precisely how two platforms end up with schemas that differ in a way nobody
 * notices until a document round-trips wrong.
 *
 * Callers append their own behavioural extensions after these.
 */
export function createDocumentExtensions(options: DocumentSchemaOptions): Extensions {
  return [
    StarterKit.configure({
      codeBlock: { HTMLAttributes: { class: "editor-code-block" } },
      heading: { levels: [1, 2, 3] },
      // StarterKit ships its own link mark; disabled so the configured one
      // below is the only definition in the schema rather than one of two.
      link: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({
      autolink: true,
      defaultProtocol: "https",
      HTMLAttributes: { class: "editor-link" },
      linkOnPaste: true,
      openOnClick: false,
    }),
    options.image ?? createPikosImageNode(options.resolveAssetUrl),
    PikosTable,
    // Schema-bearing despite appearances — see the note at the top of the file.
    // Markdown contributes `tight` to lists; TabIndent contributes `indent` to
    // paragraph and heading. Omitting either on one platform loses those
    // attributes on the next save from the other.
    Markdown.configure({
      transformCopiedText: false,
      transformPastedText: true,
    }),
    TabIndent,
  ];
}
