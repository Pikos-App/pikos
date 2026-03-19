// FormatToolbar — Static formatting toolbar pinned above the editor content.
// Active state reflects the current cursor position/selection via useEditorState.

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  Strikethrough,
  Underline,
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
    isBullet,
    isCode,
    isH1,
    isH2,
    isH3,
    isItalic,
    isLink,
    isOrdered,
    isStrike,
    isUnderline,
  } = useEditorState({
    editor,
    selector: (ctx) => ({
      isBold: ctx.editor.isActive("bold"),
      isBullet: ctx.editor.isActive("bulletList"),
      isCode: ctx.editor.isActive("code"),
      isH1: ctx.editor.isActive("heading", { level: 1 }),
      isH2: ctx.editor.isActive("heading", { level: 2 }),
      isH3: ctx.editor.isActive("heading", { level: 3 }),
      isItalic: ctx.editor.isActive("italic"),
      isLink: ctx.editor.isActive("link"),
      isOrdered: ctx.editor.isActive("orderedList"),
      isStrike: ctx.editor.isActive("strike"),
      isUnderline: ctx.editor.isActive("underline"),
    }),
  });

  const groups: ButtonGroup[] = [
    {
      buttons: [
        {
          command: () => editor.chain().focus().toggleBold().run(),
          icon: <Bold size={14} strokeWidth={2.5} />,
          isActive: isBold,
          title: "Bold",
        },
        {
          command: () => editor.chain().focus().toggleItalic().run(),
          icon: <Italic size={14} strokeWidth={2.5} />,
          isActive: isItalic,
          title: "Italic",
        },
        {
          command: () => editor.chain().focus().toggleUnderline().run(),
          icon: <Underline size={14} strokeWidth={2.5} />,
          isActive: isUnderline,
          title: "Underline",
        },
      ],
    },
    {
      buttons: [
        {
          command: () => editor.chain().focus().toggleStrike().run(),
          icon: <Strikethrough size={14} strokeWidth={2.5} />,
          isActive: isStrike,
          title: "Strikethrough",
        },
        {
          command: () => editor.chain().focus().toggleCode().run(),
          icon: <Code size={14} strokeWidth={2.5} />,
          isActive: isCode,
          title: "Inline code",
        },
      ],
    },
    {
      buttons: [
        {
          command: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
          icon: <Heading1 size={14} strokeWidth={2.5} />,
          isActive: isH1,
          title: "Heading 1",
        },
        {
          command: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          icon: <Heading2 size={14} strokeWidth={2.5} />,
          isActive: isH2,
          title: "Heading 2",
        },
        {
          command: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
          icon: <Heading3 size={14} strokeWidth={2.5} />,
          isActive: isH3,
          title: "Heading 3",
        },
      ],
    },
    {
      buttons: [
        {
          command: () => editor.chain().focus().toggleBulletList().run(),
          icon: <List size={14} strokeWidth={2.5} />,
          isActive: isBullet,
          title: "Bullet list",
        },
        {
          command: () => editor.chain().focus().toggleOrderedList().run(),
          icon: <ListOrdered size={14} strokeWidth={2.5} />,
          isActive: isOrdered,
          title: "Ordered list",
        },
      ],
    },
    {
      buttons: [
        {
          command: () => {
            if (isLink) {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              return;
            }
            onAddLink?.();
          },
          icon: <Link size={14} strokeWidth={2.5} />,
          isActive: isLink,
          title: "Link",
        },
      ],
    },
  ];

  return (
    <div className="flex items-center gap-1 border-b border-border px-4 py-1.5" data-format-toolbar>
      {groups.map((group, gi) => (
        <div className="flex items-center" key={gi}>
          {gi > 0 && <div className="mx-1.5 h-4 w-px bg-border" />}
          {group.buttons.map((btn, bi) => (
            <button
              className={[
                "flex items-center justify-center rounded p-1.5 transition-colors",
                btn.isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              ].join(" ")}
              key={bi}
              onMouseDown={(e) => {
                e.preventDefault();
                btn.command();
              }}
              title={btn.title}
            >
              {btn.icon}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
