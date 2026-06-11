import "tippy.js/dist/tippy.css";

import { type Editor, Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type {
  SuggestionKeyDownProps,
  SuggestionOptions,
  SuggestionProps,
} from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import tippy from "tippy.js";
import type { Instance as TippyInstance } from "tippy.js";

import { insertImageFromDialog } from "../extensions/PikosImage";

interface SlashCommand {
  title: string;
  description: string;
  aliases?: string[];
  icon: string;
  command: (editor: Editor) => void;
}

const COMMANDS: SlashCommand[] = [
  {
    aliases: ["h1", "heading1"],
    command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    description: "Large section heading",
    icon: "H1",
    title: "Heading 1",
  },
  {
    aliases: ["h2", "heading2"],
    command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    description: "Medium section heading",
    icon: "H2",
    title: "Heading 2",
  },
  {
    aliases: ["h3", "heading3"],
    command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    description: "Small section heading",
    icon: "H3",
    title: "Heading 3",
  },
  {
    aliases: ["ul", "unordered", "list"],
    command: (editor) => editor.chain().focus().toggleBulletList().run(),
    description: "Unordered list of items",
    icon: "•—",
    title: "Bullet List",
  },
  {
    aliases: ["ol", "numbered", "list"],
    command: (editor) => editor.chain().focus().toggleOrderedList().run(),
    description: "Numbered list of items",
    icon: "1.",
    title: "Ordered List",
  },
  {
    aliases: ["todo", "check", "checkbox"],
    command: (editor) => editor.chain().focus().toggleTaskList().run(),
    description: "Interactive checkboxes",
    icon: "☑",
    title: "Task List",
  },
  {
    aliases: ["code", "pre", "codeblock"],
    command: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    description: "Monospaced code block",
    icon: "</>",
    title: "Code Block",
  },
  {
    aliases: ["quote", "bq"],
    command: (editor) => editor.chain().focus().toggleBlockquote().run(),
    description: "Indented quote block",
    icon: "❝",
    title: "Blockquote",
  },
  {
    aliases: ["hr", "divider", "separator"],
    command: (editor) => editor.chain().focus().setHorizontalRule().run(),
    description: "Divider between sections",
    icon: "—",
    title: "Horizontal Rule",
  },
  {
    aliases: ["grid", "spreadsheet"],
    command: (editor) =>
      editor.chain().focus().insertTable({ cols: 3, rows: 3, withHeaderRow: true }).run(),
    description: "Insert a data table",
    icon: "⊞",
    title: "Table",
  },
  {
    aliases: ["img", "picture", "photo", "upload"],
    command: (editor) => void insertImageFromDialog(editor.view),
    description: "Upload an image from your files",
    icon: "🖼",
    title: "Image",
  },
];

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

interface SlashMenuListProps {
  items: SlashCommand[];
  command: (item: SlashCommand) => void;
}

interface SlashMenuListRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const SlashMenuList = forwardRef<SlashMenuListRef, SlashMenuListProps>(
  ({ command, items }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const ignoreMouseUntilMove = useRef(true);
    const containerRef = useRef<HTMLDivElement>(null);

    const [prevItems, setPrevItems] = useState(items);
    if (items !== prevItems) {
      setPrevItems(items);
      setSelectedIndex(0);
    }

    useEffect(() => {
      ignoreMouseUntilMove.current = true;
    }, [items]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const selected = container.querySelector<HTMLElement>("[data-selected='true']");
      selected?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === "ArrowUp") {
          ignoreMouseUntilMove.current = true;
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          ignoreMouseUntilMove.current = true;
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
      return (
        <div className="slash-menu-empty" role="status">
          No commands match
        </div>
      );
    }

    return (
      // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- listbox keyboard nav is handled by Tiptap suggestion (ArrowUp/Down/Enter intercepted from the editor); tabindex/focus on the container is the post-launch listbox refactor
      <div
        aria-label="Slash commands"
        className="slash-menu"
        onMouseMove={() => {
          ignoreMouseUntilMove.current = false;
        }}
        ref={containerRef}
        role="listbox"
      >
        {items.map((item, index) => (
          <button
            aria-selected={index === selectedIndex}
            className="slash-menu-item"
            data-selected={index === selectedIndex}
            key={item.title}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the editor
              command(item);
            }}
            onMouseEnter={() => {
              if (!ignoreMouseUntilMove.current) {
                setSelectedIndex(index);
              }
            }}
            role="option"
            tabIndex={-1}
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

type SlashSuggestionOptions = Omit<SuggestionOptions<SlashCommand>, "editor">;

function buildSuggestionConfig(): SlashSuggestionOptions {
  return {
    allow: ({ editor }) => {
      return editor.isFocused;
    },
    allowSpaces: false,
    char: "/",

    command: ({
      editor,
      props,
      range,
    }: {
      editor: Editor;
      range: { from: number; to: number };
      props: { item: SlashCommand };
    }) => {
      editor.chain().focus().deleteRange(range).run();
      props.item.command(editor);
    },

    items: ({ query }: { query: string }) => filterCommands(query),

    render: () => {
      let renderer: ReactRenderer<SlashMenuListRef> | null = null;
      let popup: TippyInstance[] | null = null;

      return {
        onExit() {
          popup?.[0]?.destroy();
          popup = null;
          renderer?.destroy();
          renderer = null;
        },

        onKeyDown(props: SuggestionKeyDownProps) {
          if (props.event.key === "Escape") {
            popup?.[0]?.hide();
            return true;
          }
          return renderer?.ref?.onKeyDown(props) ?? false;
        },

        onStart(props: SuggestionProps<SlashCommand>) {
          renderer = new ReactRenderer(SlashMenuList, {
            editor: props.editor,
            props: {
              command: (item: SlashCommand) => {
                props.command({ id: item.title, item, label: item.title });
              },
              items: props.items,
            },
          });

          if (!props.clientRect) return;

          popup = tippy("body", {
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

        onUpdate(props: SuggestionProps<SlashCommand>) {
          renderer?.updateProps({
            command: (item: SlashCommand) => {
              props.command({ id: item.title, item, label: item.title });
            },
            items: props.items,
          });

          if (!props.clientRect) return;

          popup?.[0]?.setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          });
        },
      };
    },

    startOfLine: false,
  };
}

export const SlashMenuExtension = Extension.create({
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

  name: "slashMenu",
});
