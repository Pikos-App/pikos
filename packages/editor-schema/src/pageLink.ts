import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";

/** What a link reads as on the page: its label, else the title it carries. */
export function pageLinkText(node: PmNode): string {
  const label = node.attrs["label"] as string | null;

  return label || (node.attrs["title"] as string);
}

/**
 * A link from one page to another, stored by the target's id so a rename never
 * breaks it.
 *
 * `title` is the target's title when the link was made. It is a fallback, not
 * the source of truth: a platform shows the target's current title when it has
 * one, and falls back to this for a target it hasn't loaded or that is gone.
 * `label`, when set, is shown instead of any title, so it is the one thing a
 * rename doesn't change. Markdown writes the link as `[[title]]` or
 * `[[title|label]]`, the forms the CLI reads back.
 */
export const PageLink = Node.create({
  addAttributes() {
    return {
      label: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-label"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes["label"] ? { "data-label": attributes["label"] } : {},
      },
      pageId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-page-id"),
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-page-id": attributes["pageId"],
        }),
      },
      title: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-title") ?? element.textContent ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-title": attributes["title"],
        }),
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        parse: {},
        serialize(
          state: { write: (text: string) => void },
          node: { attrs: { label: string | null; title: string } }
        ) {
          const { label, title } = node.attrs;
          state.write(label ? `[[${title}|${label}]]` : `[[${title}]]`);
        },
      },
    };
  },

  atom: true,

  // The word count reads a block's text through ProseMirror, which sees nothing of an inline
  // node without this.
  extendNodeSchema() {
    return { leafText: pageLinkText };
  },

  group: "inline",
  inline: true,
  name: "pageLink",

  parseHTML() {
    return [{ tag: "span[data-page-link]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "page-link", "data-page-link": "" }),
      pageLinkText(node),
    ];
  },

  renderText({ node }) {
    return pageLinkText(node);
  },

  selectable: false,
});
