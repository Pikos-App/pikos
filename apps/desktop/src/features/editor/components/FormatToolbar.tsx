// FormatToolbar — Selection-triggered bubble toolbar.
// Appears anchored above the active selection via Tiptap's BubbleMenu.
// Hides automatically when the selection collapses or focus leaves the editor.

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
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

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";

interface FormatToolbarProps {
  editor: Editor;
  onAddLink?: () => void;
}

interface ToolbarButton {
  command: () => void;
  icon: React.ReactNode;
  isActive: boolean;
  shortcut?: string;
  title: string;
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
          shortcut: "mod+b",
          title: "Bold",
        },
        {
          command: () => editor.chain().focus().toggleItalic().run(),
          icon: <Italic size={14} strokeWidth={2.5} />,
          isActive: isItalic,
          shortcut: "mod+i",
          title: "Italic",
        },
        {
          command: () => editor.chain().focus().toggleUnderline().run(),
          icon: <Underline size={14} strokeWidth={2.5} />,
          isActive: isUnderline,
          shortcut: "mod+u",
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
          shortcut: "mod+shift+x",
          title: "Strikethrough",
        },
        {
          command: () => editor.chain().focus().toggleCode().run(),
          icon: <Code size={14} strokeWidth={2.5} />,
          isActive: isCode,
          shortcut: "mod+e",
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
            // Blur the editor DOM so BubbleMenuView's blurHandler fires and hides
            // the bubble menu. ProseMirror preserves the selection in editor.state
            // so LinkPopover can still apply the link to the correct range.
            editor.view.dom.blur();
            onAddLink?.();
          },
          icon: <Link size={14} strokeWidth={2.5} />,
          isActive: isLink,
          shortcut: "mod+k",
          title: "Link",
        },
      ],
    },
  ];

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top" }}
      shouldShow={({ editor: ed, state }) => ed.isFocused && !state.selection.empty}
    >
      <div className="bubble-toolbar" data-format-toolbar>
        {groups.map((group, gi) => (
          <div className="flex items-center" key={gi}>
            {gi > 0 && <div className="bubble-toolbar-divider" />}
            {group.buttons.map((btn, bi) => (
              <Tooltip key={bi}>
                <TooltipTrigger asChild>
                  <button
                    aria-label={btn.title}
                    className={["bubble-toolbar-btn", btn.isActive ? "is-active" : ""].join(" ")}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      btn.command();
                    }}
                  >
                    {btn.icon}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <span className={`inline-flex items-center${btn.shortcut ? "gap-1.5" : ""}`}>
                    {btn.title}
                    {btn.shortcut && <KeyboardShortcut shortcut={btn.shortcut} />}
                  </span>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
      </div>
    </BubbleMenu>
  );
}
