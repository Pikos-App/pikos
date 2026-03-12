// FormatToolbar — Static formatting toolbar pinned above the editor content.
// Active state reflects the current cursor position/selection via useEditorState.

import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
} from "lucide-react";

interface FormatToolbarProps {
  editor: Editor;
  onAddLink?: () => void;
}

interface ToolbarButton {
  icon: React.ReactNode;
  title: string;
  isActive: boolean;
  command: () => void;
}

interface ButtonGroup {
  buttons: ToolbarButton[];
}

export function FormatToolbar({ editor, onAddLink }: FormatToolbarProps) {
  const {
    isBold,
    isItalic,
    isUnderline,
    isStrike,
    isCode,
    isLink,
    isH1,
    isH2,
    isH3,
    isBullet,
    isOrdered,
  } = useEditorState({
    editor,
    selector: (ctx) => ({
      isBold: ctx.editor.isActive("bold"),
      isItalic: ctx.editor.isActive("italic"),
      isUnderline: ctx.editor.isActive("underline"),
      isStrike: ctx.editor.isActive("strike"),
      isCode: ctx.editor.isActive("code"),
      isLink: ctx.editor.isActive("link"),
      isH1: ctx.editor.isActive("heading", { level: 1 }),
      isH2: ctx.editor.isActive("heading", { level: 2 }),
      isH3: ctx.editor.isActive("heading", { level: 3 }),
      isBullet: ctx.editor.isActive("bulletList"),
      isOrdered: ctx.editor.isActive("orderedList"),
    }),
  });

  const groups: ButtonGroup[] = [
    {
      buttons: [
        {
          icon: <Bold size={14} strokeWidth={2.5} />,
          title: "Bold",
          isActive: isBold,
          command: () => editor.chain().focus().toggleBold().run(),
        },
        {
          icon: <Italic size={14} strokeWidth={2.5} />,
          title: "Italic",
          isActive: isItalic,
          command: () => editor.chain().focus().toggleItalic().run(),
        },
        {
          icon: <Underline size={14} strokeWidth={2.5} />,
          title: "Underline",
          isActive: isUnderline,
          command: () => editor.chain().focus().toggleUnderline().run(),
        },
      ],
    },
    {
      buttons: [
        {
          icon: <Strikethrough size={14} strokeWidth={2.5} />,
          title: "Strikethrough",
          isActive: isStrike,
          command: () => editor.chain().focus().toggleStrike().run(),
        },
        {
          icon: <Code size={14} strokeWidth={2.5} />,
          title: "Inline code",
          isActive: isCode,
          command: () => editor.chain().focus().toggleCode().run(),
        },
      ],
    },
    {
      buttons: [
        {
          icon: <Heading1 size={14} strokeWidth={2.5} />,
          title: "Heading 1",
          isActive: isH1,
          command: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        },
        {
          icon: <Heading2 size={14} strokeWidth={2.5} />,
          title: "Heading 2",
          isActive: isH2,
          command: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        },
        {
          icon: <Heading3 size={14} strokeWidth={2.5} />,
          title: "Heading 3",
          isActive: isH3,
          command: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
        },
      ],
    },
    {
      buttons: [
        {
          icon: <List size={14} strokeWidth={2.5} />,
          title: "Bullet list",
          isActive: isBullet,
          command: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          icon: <ListOrdered size={14} strokeWidth={2.5} />,
          title: "Ordered list",
          isActive: isOrdered,
          command: () => editor.chain().focus().toggleOrderedList().run(),
        },
      ],
    },
    {
      buttons: [
        {
          icon: <Link size={14} strokeWidth={2.5} />,
          title: "Link",
          isActive: isLink,
          command: () => {
            if (isLink) {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              return;
            }
            onAddLink?.();
          },
        },
      ],
    },
  ];

  return (
    <div data-format-toolbar className="flex items-center gap-1 border-b border-border px-4 py-1.5">
      {groups.map((group, gi) => (
        <div key={gi} className="flex items-center">
          {gi > 0 && <div className="mx-1.5 h-4 w-px bg-border" />}
          {group.buttons.map((btn, bi) => (
            <button
              key={bi}
              title={btn.title}
              onMouseDown={(e) => {
                e.preventDefault();
                btn.command();
              }}
              className={[
                "flex items-center justify-center rounded p-1.5 transition-colors",
                btn.isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              ].join(" ")}
            >
              {btn.icon}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
