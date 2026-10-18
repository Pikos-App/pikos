import { mergeAttributes, Node } from "@tiptap/core";

/**
 * A link from one page to another, stored by the target's id so a rename never
 * breaks it.
 *
 * `title` is the target's title when the link was made. It is a fallback, not
 * the source of truth: a platform shows the target's current title when it has
 * one, and falls back to this for a target it hasn't loaded or that is gone.
 * Markdown writes the link as `[[title]]`, the form the CLI reads back.
 */
export const PageLink = Node.create({
  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-page-id"),
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-page-id": attributes["pageId"],
        }),
      },
      title: {
        default: "",
        parseHTML: (element: HTMLElement) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        parse: {},
        serialize(state: { write: (text: string) => void }, node: { attrs: { title: string } }) {
          state.write(`[[${node.attrs.title}]]`);
        },
      },
    };
  },

  atom: true,
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
      node.attrs["title"] as string,
    ];
  },

  renderText({ node }) {
    return node.attrs["title"] as string;
  },

  selectable: false,
});
