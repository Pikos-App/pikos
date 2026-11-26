// The Tiptap document schema, and nothing else. A document written on one device must
// parse identically on the other, so this holds exactly what changes `getJSON()`.
//
// The test for a new extension is whether omitting it on one platform would change
// `getJSON()`, not whether it is a node or a mark. TabIndent adds `indent` to paragraph and
// heading, and Markdown adds `tight` to lists; omitting either drops those attributes on
// the next save from the other platform. Check the snapshot test rather than the name.
//
// Placeholders, slash menus, input rules, node views and drop handling stay out: they
// differ by platform and cannot change a stored document.

import type { Extensions } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

import { createPikosImageNode, type ResolveAssetUrl } from "./image";
import { PageLink } from "./pageLink";
import { TabIndent } from "./tabIndent";
import { PikosTable } from "./table";

export { createPikosImageNode, PageLink, PikosTable, TabIndent };
export {
  getIndentLevel,
  isCursorAtLineStart,
  setIndentForSelection,
} from "./tabIndent";
export { Markdown } from "tiptap-markdown";
export type { ResolveAssetUrl };

export interface DocumentSchemaOptions {
  resolveAssetUrl: ResolveAssetUrl;
  /**
   * Replaces the default image node. Pass
   * `createPikosImageNode(resolveAssetUrl).extend({ ... })` so the platform's rendering is
   * layered on and the image attributes stay identical.
   */
  image?: Extensions[number];
  /**
   * Replaces StarterKit's code block, as `image` does: pass an extension of
   * `CodeBlock`, so the `language` attribute and its Markdown fence tag stay.
   */
  codeBlock?: Extensions[number];
  /**
   * Replaces the default Markdown extension. Pass a reconfigured `Markdown` so the `tight`
   * list attribute survives and only parsing changes. The Obsidian importer needs
   * `breaks: true` because Obsidian renders a single newline as a line break and CommonMark
   * does not.
   */
  markdown?: Extensions[number];
  /** Replaces the default page link node, as `image` does: pass `PageLink.extend({ ... })`. */
  pageLink?: Extensions[number];
  /** See `TabIndentOptions.onKeyHandled`. */
  onKeyHandled?: (event: KeyboardEvent) => void;
}

/**
 * The schema-bearing extensions in a fixed order, which matters where extensions override
 * one another's attributes. Callers append their own behavioural extensions after these and
 * swap a piece through the options rather than reassembling the list, which is how two
 * platforms end up with schemas that differ unnoticed.
 */
export function createDocumentExtensions(options: DocumentSchemaOptions): Extensions {
  return [
    StarterKit.configure({
      codeBlock: options.codeBlock ? false : { HTMLAttributes: { class: "editor-code-block" } },
      heading: { levels: [1, 2, 3] },
      // The configured Link below must be the only link definition in the schema.
      link: false,
    }),
    ...(options.codeBlock ? [options.codeBlock] : []),
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
    options.pageLink ?? PageLink,
    // Markdown and TabIndent are schema-bearing; see the header.
    options.markdown ??
      Markdown.configure({
        transformCopiedText: false,
        transformPastedText: true,
      }),
    TabIndent.configure({ onKeyHandled: options.onKeyHandled }),
  ];
}
