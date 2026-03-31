// ShortcutsSettings — reference list of all keyboard shortcuts, grouped by context.
// Update this file when adding new shortcuts to the app.

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = "⇧";
const ALT = isMac ? "⌥" : "Alt";

/** Format a combo string like "Mod+Shift+C" into display tokens. */
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
      { combo: "Mod+\\", label: "Toggle sidebar" },
      { combo: "Mod+Shift+C", label: "Toggle calendar / editor" },
      { combo: "Mod+Shift+D", label: "Delete page" },
      { combo: "Mod+1–9", label: "Switch to folder by index" },
    ],
    label: "Navigation",
  },
  {
    items: [
      { combo: "ArrowUp", label: "Select previous page" },
      { combo: "ArrowDown", label: "Select next page" },
    ],
    label: "Page list",
  },
  {
    items: [
      { combo: "ArrowUp", label: "Select previous view / folder" },
      { combo: "ArrowDown", label: "Select next view / folder" },
    ],
    label: "Sidebar",
  },
  {
    items: [
      { combo: "/", label: "Slash menu" },
      { combo: "Mod+Shift+K", label: "Insert / edit link" },
      { combo: "Mod+F", label: "Find in page" },
      { combo: "Tab", label: "Indent" },
      { combo: "Shift+Tab", label: "Outdent" },
    ],
    label: "Editor",
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
    // Chord: show both parts separated by "then"
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
        {isMac ? "⌘ is Cmd, ⇧ is Shift, ⌥ is Option." : "Ctrl replaces Cmd on this platform."}
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
