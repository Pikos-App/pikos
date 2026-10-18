import { type Editor, Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useImperativeHandle, useState } from "react";
import tippy from "tippy.js";
import type { Instance as TippyInstance } from "tippy.js";

import { Keyboard } from "@/shared/keyboard/registry";

export interface LinkTarget {
  id: string;
  title: string;
}

/** Pages whose titles match `query`, for the picker. Set per editor by its owner. */
export type FindLinkTargets = (query: string) => Promise<LinkTarget[]>;

interface PickerStorage {
  find: FindLinkTargets;
}

declare module "@tiptap/core" {
  interface Storage {
    pageLinkPicker: PickerStorage;
  }
  interface Commands<ReturnType> {
    pageLinkPicker: {
      setLinkTargetFinder: (find: FindLinkTargets) => ReturnType;
    };
  }
}

interface PageLinkListProps {
  items: LinkTarget[];
  command: (item: LinkTarget) => void;
}

export interface PageLinkListRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

export const PageLinkList = forwardRef<PageLinkListRef, PageLinkListProps>(
  ({ command, items }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    const [prevItems, setPrevItems] = useState(items);
    if (items !== prevItems) {
      setPrevItems(items);
      setSelectedIndex(0);
    }

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        const hasItems = items.length > 0;
        if (event.key === "ArrowUp" && hasItems) {
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }

        if (event.key === "ArrowDown" && hasItems) {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }

        const item = items[selectedIndex];
        if (event.key === "Enter" && item) {
          command(item);
          return true;
        }

        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="slash-menu-empty" role="status">
          No pages match
        </div>
      );
    }

    return (
      <div aria-label="Link to page" className="slash-menu" role="listbox">
        {items.map((item, index) => (
          <button
            aria-selected={index === selectedIndex}
            className="slash-menu-item"
            data-selected={index === selectedIndex}
            key={item.id}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the editor
              command(item);
            }}
            role="option"
            tabIndex={-1}
          >
            <span className="slash-menu-item-title">{item.title || "Untitled"}</span>
          </button>
        ))}
      </div>
    );
  }
);
PageLinkList.displayName = "PageLinkList";

function insertLink(editor: Editor, range: { from: number; to: number }, item: LinkTarget) {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { attrs: { pageId: item.id, title: item.title }, type: "pageLink" },
      { text: " ", type: "text" },
    ])
    .run();
}

function renderPopup() {
  let renderer: ReactRenderer<PageLinkListRef, PageLinkListProps> | null = null;
  let popup: TippyInstance | null = null;

  const listProps = (props: SuggestionProps<LinkTarget>): PageLinkListProps => ({
    command: (item) => props.command(item),
    items: props.items,
  });

  return {
    onExit() {
      popup?.destroy();
      popup = null;
      renderer?.destroy();
      renderer = null;
    },

    onKeyDown(props: SuggestionKeyDownProps) {
      if (props.event.key === "Escape") {
        popup?.hide();
        Keyboard.markUsed(props.event);
        return true;
      }
      return renderer?.ref?.onKeyDown(props) ?? false;
    },

    onStart(props: SuggestionProps<LinkTarget>) {
      renderer = new ReactRenderer(PageLinkList, { editor: props.editor, props: listProps(props) });
      if (!props.clientRect) return;

      popup = tippy(document.body, {
        appendTo: () => document.body,
        content: renderer.element,
        getReferenceClientRect: props.clientRect as () => DOMRect,
        interactive: true,
        placement: "bottom-start",
        showOnCreate: true,
        theme: "slash-menu",
        trigger: "manual",
      });
    },

    onUpdate(props: SuggestionProps<LinkTarget>) {
      renderer?.updateProps(listProps(props));
      if (!props.clientRect) return;

      popup?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect });
    },
  };
}

/** Its own key, since the slash menu's suggestion plugin holds the default one. */
const PAGE_LINK_PICKER_KEY = new PluginKey("pageLinkPicker");

/** Typing `[[` opens a picker of the pages whose titles match what follows, and links the one
 *  chosen. Only an existing page can be linked: the picker never creates one. */
export const PageLinkPicker = Extension.create<object, PickerStorage>({
  addCommands() {
    return {
      setLinkTargetFinder: (find) => () => {
        this.storage.find = find;
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<LinkTarget, LinkTarget>({
        allow: ({ editor, state }) =>
          editor.isFocused && !state.selection.$from.parent.type.spec.code,
        allowSpaces: true,
        char: "[[",
        command: ({ editor, props, range }) => insertLink(editor, range, props),
        editor: this.editor,
        items: ({ query }) => this.storage.find(query.trim()),
        pluginKey: PAGE_LINK_PICKER_KEY,
        render: renderPopup,
        startOfLine: false,
      }),
    ];
  },

  addStorage() {
    return { find: () => Promise.resolve([]) };
  },

  name: "pageLinkPicker",
});
