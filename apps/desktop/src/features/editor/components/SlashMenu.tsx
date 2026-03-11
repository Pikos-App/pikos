// SlashMenu — Slash command palette for inserting block types.
// Type "/" in the editor to open a filterable list of commands.
// Powered by @tiptap/suggestion + tippy.js + ReactRenderer.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Extension, type Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type {
  SuggestionOptions,
  SuggestionProps,
  SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import tippy from "tippy.js";
import type { Instance as TippyInstance } from "tippy.js";
import "tippy.js/dist/tippy.css";

// ─── Command definitions ────────────────────────────────────────────────────

interface SlashCommand {
  title: string;
  description: string;
  aliases?: string[];
  icon: string;
  command: (editor: Editor) => void;
}

const COMMANDS: SlashCommand[] = [
  {
    title: "Heading 1",
    description: "Large section heading",
    aliases: ["h1", "heading1"],
    icon: "H1",
    command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    aliases: ["h2", "heading2"],
    icon: "H2",
    command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    aliases: ["h3", "heading3"],
    icon: "H3",
    command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    title: "Bullet List",
    description: "Unordered list of items",
    aliases: ["ul", "unordered", "list"],
    icon: "•—",
    command: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    title: "Ordered List",
    description: "Numbered list of items",
    aliases: ["ol", "numbered", "list"],
    icon: "1.",
    command: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    title: "Task List",
    description: "Interactive checkboxes",
    aliases: ["todo", "check", "checkbox"],
    icon: "☑",
    command: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    title: "Code Block",
    description: "Monospaced code block",
    aliases: ["code", "pre", "codeblock"],
    icon: "</>",
    command: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    title: "Blockquote",
    description: "Indented quote block",
    aliases: ["quote", "bq"],
    icon: "❝",
    command: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    title: "Horizontal Rule",
    description: "Divider between sections",
    aliases: ["hr", "divider", "separator"],
    icon: "—",
    command: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];

// ─── Fuzzy filter ───────────────────────────────────────────────────────────

function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase().trim();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
    (cmd) =>
      cmd.title.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q) ||
      cmd.aliases?.some((alias) => alias.includes(q))
  );
}

// ─── SlashMenuList (rendered inside tippy) ──────────────────────────────────

interface SlashMenuListProps {
  items: SlashCommand[];
  command: (item: SlashCommand) => void;
}

export interface SlashMenuListRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

export const SlashMenuList = forwardRef<SlashMenuListRef, SlashMenuListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    // Reset selection when items list changes — derive during render to avoid setState-in-effect
    const [prevItems, setPrevItems] = useState(items);
    if (items !== prevItems) {
      setPrevItems(items);
      setSelectedIndex(0);
    }

    // Scroll selected item into view
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const selected = container.querySelector<HTMLElement>("[data-selected='true']");
      selected?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selectedIndex];
          if (item) {
            command(item);
            return true;
          }
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return <div className="slash-menu-empty">No commands match</div>;
    }

    return (
      <div ref={containerRef} className="slash-menu">
        {items.map((item, index) => (
          <button
            key={item.title}
            data-selected={index === selectedIndex}
            className="slash-menu-item"
            onClick={() => command(item)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <span className="slash-menu-item-icon">{item.icon}</span>
            <span className="slash-menu-item-text">
              <span className="slash-menu-item-title">{item.title}</span>
              <span className="slash-menu-item-description">{item.description}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }
);
SlashMenuList.displayName = "SlashMenuList";

// ─── Suggestion config ──────────────────────────────────────────────────────

type SlashSuggestionOptions = Omit<SuggestionOptions<SlashCommand>, "editor">;

export function buildSuggestionConfig(): SlashSuggestionOptions {
  return {
    char: "/",
    allowSpaces: false,
    startOfLine: false,

    items: ({ query }: { query: string }) => filterCommands(query),

    render: () => {
      let renderer: ReactRenderer<SlashMenuListRef> | null = null;
      let popup: TippyInstance[] | null = null;

      return {
        onStart(props: SuggestionProps<SlashCommand>) {
          renderer = new ReactRenderer(SlashMenuList, {
            props: {
              items: props.items,
              command: (item: SlashCommand) => {
                props.command({ id: item.title, label: item.title, item });
              },
            },
            editor: props.editor,
          });

          if (!props.clientRect) return;

          popup = tippy("body", {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: renderer.element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
            theme: "slash-menu",
          });
        },

        onUpdate(props: SuggestionProps<SlashCommand>) {
          renderer?.updateProps({
            items: props.items,
            command: (item: SlashCommand) => {
              props.command({ id: item.title, label: item.title, item });
            },
          });

          if (!props.clientRect) return;

          popup?.[0]?.setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          });
        },

        onKeyDown(props: SuggestionKeyDownProps) {
          if (props.event.key === "Escape") {
            popup?.[0]?.hide();
            return true;
          }
          return renderer?.ref?.onKeyDown(props) ?? false;
        },

        onExit() {
          popup?.[0]?.destroy();
          popup = null;
          renderer?.destroy();
          renderer = null;
        },
      };
    },

    command: ({
      editor,
      range,
      props,
    }: {
      editor: Editor;
      range: { from: number; to: number };
      props: { item: SlashCommand };
    }) => {
      // Delete the "/" + query text, then run the block command
      editor.chain().focus().deleteRange(range).run();
      props.item.command(editor);
    },
  };
}

// ─── Extension ──────────────────────────────────────────────────────────────

export const SlashMenuExtension = Extension.create({
  name: "slashMenu",

  addOptions() {
    return {
      suggestion: buildSuggestionConfig(),
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
