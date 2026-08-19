// Rendered from the keyboard registry: every shortcut registered with a label
// and a group lands here without this file knowing about it. The only entries
// spelled out below are the ones the registry can never see — keys ProseMirror
// and the Quick Add form own, handled inside those components' own keymaps.

import { IS_MACOS } from "@/shared/constants/platform";
import { formatCombo } from "@/shared/keyboard/formatCombo";
import type { ShortcutDoc } from "@/shared/keyboard/registry";
import { Keyboard } from "@/shared/keyboard/registry";

/** Section order on the page. Anything in a group not named here follows, in
 *  registration order, so a new group shows up rather than disappearing. */
const GROUP_ORDER = ["Navigation", "Page list", "Editor", "Quick add", "Calendar"];

/** Keys owned by the Tiptap editor and the Quick Add form, which never register
 *  with the keyboard registry — their components bind them directly. */
const EXTERNAL_SHORTCUTS: ShortcutDoc[] = [
  { combo: "/", group: "Editor", label: "Slash menu" },
  { combo: "Mod+B", group: "Editor", label: "Bold" },
  { combo: "Mod+I", group: "Editor", label: "Italic" },
  { combo: "Mod+Shift+S", group: "Editor", label: "Strikethrough" },
  { combo: "Mod+E", group: "Editor", label: "Inline code" },
  { combo: "Tab", group: "Editor", label: "Indent" },
  { combo: "Shift+Tab", group: "Editor", label: "Outdent" },
  { combo: "Enter", group: "Quick add", label: "Add and close" },
  { combo: "Mod+Enter", group: "Quick add", label: "Add and stay open" },
  { combo: "Shift+Enter", group: "Quick add", label: "Add and open the new page" },
];

function KeyBadge({ token }: { token: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-sm leading-none text-foreground shadow-sm">
      {token}
    </kbd>
  );
}

function ComboDisplay({ combo }: { combo: string }) {
  return (
    <span className="flex items-center gap-1">
      {formatCombo(combo).map((t, i) => (
        <KeyBadge key={i} token={t} />
      ))}
    </span>
  );
}

/** Registry entries plus the externally-owned ones, grouped for display.
 *  Within a group entries sort by label: registration order follows React's
 *  mount order, which is an implementation detail, not a reading order. */
function groupShortcuts(entries: ShortcutDoc[]): { items: ShortcutDoc[]; label: string }[] {
  const byGroup = new Map<string, ShortcutDoc[]>();
  for (const entry of entries) {
    const bucket = byGroup.get(entry.group);
    if (bucket) bucket.push(entry);
    else byGroup.set(entry.group, [entry]);
  }

  const ordered = [
    ...GROUP_ORDER.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return ordered.map((label) => ({
    items: [...(byGroup.get(label) ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
    label,
  }));
}

export function ShortcutsSettings() {
  const groups = groupShortcuts([...Keyboard.listShortcutCatalog(), ...EXTERNAL_SHORTCUTS]);

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold">Keyboard Shortcuts</h2>
      <p className="mb-6 text-sm text-muted-foreground">
        {IS_MACOS ? "⌘ is Cmd, ⇧ is Shift, ⌥ is Option." : "Ctrl replaces Cmd on this platform."}
      </p>

      <div className="space-y-6">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {group.label}
            </p>
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {group.items.map((item) => (
                <div
                  className="flex items-center justify-between gap-4 px-4 py-2.5"
                  key={`${item.group}-${item.label}`}
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
