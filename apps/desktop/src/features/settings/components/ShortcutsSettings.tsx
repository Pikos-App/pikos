// Update this file when adding new shortcuts to the app.

import { IS_MACOS } from "@/shared/constants/platform";

const MOD = IS_MACOS ? "⌘" : "Ctrl";
const SHIFT = "⇧";
const ALT = IS_MACOS ? "⌥" : "Alt";

function formatCombo(combo: string): string[] {
  return combo.split("+").map((part) => {
    switch (part.trim()) {
      case "Mod":
        return MOD;
      case "Shift":
        return SHIFT;
      case "Alt":
      case "Option":
        return ALT;
      case "Enter":
        return "↵";
      case "Tab":
        return "⇥";
      case "ArrowUp":
        return "↑";
      case "ArrowDown":
        return "↓";
      case "ArrowLeft":
        return "←";
      case "ArrowRight":
        return "→";
      case "\\":
        return "\\";
      case "Space":
        return "Space";
      case "Escape":
        return "Esc";
      default:
        return part.trim().toUpperCase();
    }
  });
}

interface ShortcutItem {
  label: string;
  combo: string | [string, string]; // single or chord
}

interface ShortcutGroup {
  label: string;
  items: ShortcutItem[];
}

const GROUPS: ShortcutGroup[] = [
  {
    items: [
      { combo: "Mod+N", label: "New page" },
      { combo: "Mod+W", label: "Close page" },
      { combo: "Mod+K", label: "Search" },
      { combo: "Mod+,", label: "Settings" },
      { combo: "Mod+/", label: "Keyboard shortcuts" },
      { combo: "Mod+\\", label: "Toggle sidebar" },
      { combo: "Mod+Shift+C", label: "Toggle calendar / editor" },
      { combo: "Mod+Backspace", label: "Delete page" },
      { combo: "Mod+Shift+Backspace", label: "Delete page (works in text inputs)" },
      { combo: "Mod+Z", label: "Undo delete" },
      { combo: "Mod+1–9", label: "Switch to folder by index" },
    ],
    label: "Navigation",
  },
  {
    items: [
      { combo: "ArrowUp", label: "Select previous page" },
      { combo: "ArrowDown", label: "Select next page" },
      { combo: "Space", label: "Toggle completion" },
      { combo: "Mod+A", label: "Select all open pages in folder" },
      { combo: "Escape", label: "Clear multi-selection" },
    ],
    label: "Page list",
  },
  {
    items: [
      { combo: "/", label: "Slash menu" },
      { combo: "Mod+B", label: "Bold" },
      { combo: "Mod+I", label: "Italic" },
      { combo: "Mod+Shift+S", label: "Strikethrough" },
      { combo: "Mod+E", label: "Inline code" },
      { combo: "Mod+Shift+K", label: "Insert / edit link" },
      { combo: "Mod+F", label: "Find in page" },
      { combo: "Tab", label: "Indent" },
      { combo: "Shift+Tab", label: "Outdent" },
    ],
    label: "Editor",
  },
  {
    items: [
      { combo: "Enter", label: "Add and close" },
      { combo: "Mod+Enter", label: "Add and stay open" },
      { combo: "Shift+Enter", label: "Add and open the new page" },
      { combo: "Mod+T", label: "Schedule for today" },
    ],
    label: "Quick add",
  },
  {
    items: [
      { combo: "ArrowLeft", label: "Previous week" },
      { combo: "ArrowRight", label: "Next week" },
      { combo: "T", label: "Jump to today" },
    ],
    label: "Calendar",
  },
];

function KeyBadge({ token }: { token: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-sm leading-none text-foreground shadow-sm">
      {token}
    </kbd>
  );
}

function ComboDisplay({ combo }: { combo: string | [string, string] }) {
  if (Array.isArray(combo)) {
    const [first, second] = combo;
    return (
      <span className="flex items-center gap-1">
        {formatCombo(first).map((t, i) => (
          <KeyBadge key={i} token={t} />
        ))}
        <span className="text-xs text-muted-foreground">then</span>
        {formatCombo(second).map((t, i) => (
          <KeyBadge key={i} token={t} />
        ))}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      {formatCombo(combo).map((t, i) => (
        <KeyBadge key={i} token={t} />
      ))}
    </span>
  );
}

export function ShortcutsSettings() {
  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold">Keyboard Shortcuts</h2>
      <p className="mb-6 text-sm text-muted-foreground">
        {IS_MACOS ? "⌘ is Cmd, ⇧ is Shift, ⌥ is Option." : "Ctrl replaces Cmd on this platform."}
      </p>

      <div className="space-y-6">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {group.label}
            </p>
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {group.items.map((item) => (
                <div
                  className="flex items-center justify-between gap-4 px-4 py-2.5"
                  key={item.label}
                >
                  <span className="text-sm">{item.label}</span>
                  <ComboDisplay combo={item.combo} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
