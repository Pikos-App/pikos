import { IS_MACOS } from "@/shared/constants/platform";
import { createLogger } from "@/shared/logger";

const log = createLogger("Keyboard");

export type Binding = {
  id: string;
  combo: string;
  scope?: string;
  /**
   * Short imperative name ("New page"). It is what the command palette lists and the shortcuts
   * settings page renders, so a binding without one is invisible to both (right for the internal
   * half of a chord).
   */
  label?: string;
  group?: string;
  /** False for a command that opens the command palette: run from inside it, it
   *  only closes the palette it was chosen in. Static rather than a `when` gate,
   *  which the palette's snapshot reads a render stale. */
  inPalette?: boolean;
  /** Lists after every command that matches the palette's filter as well, so the
   *  palette never opens with it highlighted for a stray Enter. */
  destructive?: boolean;
  handler: (e: KeyboardEvent) => void;
  when?: () => boolean;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  repeat?: boolean;
  allowInInputs?: boolean;
  /** Stand down when an earlier listener already used the key, such as a popover
   *  closing or the editor collapsing a selection on Escape (see `wasUsed`). */
  unlessHandled?: boolean;
};

export type NormalizedCombo = {
  key: string; // lowercase
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  // KeyboardEvent.key for the space bar is the literal " " character; accept
  // the friendlier "space" form in combo strings.
  if (lower === "space") return " ";
  // "+" cannot be written literally in a combo string — parseCombo splits on it.
  if (lower === "plus") return "+";
  return lower;
}

function parseCombo(combo: string): NormalizedCombo {
  const parts = combo.split("+").map((p) => p.trim());

  let key = "";
  let mod = false,
    ctrl = false,
    meta = false,
    alt = false,
    shift = false;

  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "mod") {
      mod = true;
    } else if (lower === "cmd" || lower === "meta") {
      meta = true;
    } else if (lower === "ctrl" || lower === "control") {
      ctrl = true;
    } else if (lower === "alt" || lower === "option") {
      alt = true;
    } else if (lower === "shift") {
      shift = true;
    } else {
      key = normalizeKey(lower);
    }
  }

  return { alt, ctrl, key, meta, mod, shift };
}

function normalizeEvent(e: KeyboardEvent): NormalizedCombo {
  const key = normalizeKey(e.key);
  return {
    alt: e.altKey,
    ctrl: e.ctrlKey,
    key,
    meta: e.metaKey,
    mod: IS_MACOS ? e.metaKey : e.ctrlKey,
    shift: e.shiftKey,
  };
}

function matchCombo(evt: NormalizedCombo, bind: NormalizedCombo): boolean {
  if (evt.key !== bind.key) return false;

  if (evt.alt !== bind.alt) return false;
  if (evt.shift !== bind.shift) return false;

  if (bind.mod) {
    if (!evt.mod) return false;
    // When using Mod, don't additionally require explicit ctrl/meta flags.
  } else {
    if (evt.ctrl !== bind.ctrl) return false;
    if (evt.meta !== bind.meta) return false;
  }

  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || el.isContentEditable) return true;
  return false;
}

// True while a modal (alert)dialog is mounted and open. Radix keeps the
// content node mounted during the close animation, so we match on
// data-state="open" to avoid suppressing shortcuts during the dismiss frame.
// Covers both the shadcn Dialog and AlertDialog families via their slot names,
// and `data-modal-surface`: a full-window overlay that isn't a Radix dialog, such
// as Settings, which otherwise let Cmd+Backspace delete the page behind it.
function isBlockingDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  const open = document.querySelectorAll(
    '[data-slot="dialog-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"], [data-modal-surface]'
  );
  return [...open].some((el) => !(listingForPalette && el.hasAttribute("data-command-palette")));
}

let listingForPalette = false;

export type ShortcutDoc = {
  combo: string;
  group: string;
  label: string;
};

const store = new Map<string, Binding & { parsed: NormalizedCombo }>();
// Every labelled binding this session has seen, one row per scope, key and group.
// Registrations come and go with their component, and a reference list that empties
// as you switch panels documents nothing, so entries are never evicted. A binding
// whose label follows the view (the calendar's week or month) replaces its row
// rather than adding a second one for the same key.
const catalog = new Map<string, ShortcutDoc>();
let activeScopes: string[] = ["global"]; // top is last

const usedInEditor = new WeakSet<KeyboardEvent>();

/** ProseMirror prevents the default of every Enter and Escape typed in the editor, whether or not
 *  anything there acted on it, so inside the editor only a `markUsed` call counts as use. */
function wasUsed(e: KeyboardEvent): boolean {
  if (usedInEditor.has(e)) return true;
  const el = e.target as HTMLElement | null;
  const inEditor = typeof el?.closest === "function" && el.closest(".ProseMirror") != null;
  return e.defaultPrevented && !inEditor;
}

function conflictKey(parsed: NormalizedCombo): string {
  return [
    parsed.key,
    parsed.mod ? "mod" : "",
    parsed.ctrl ? "ctrl" : "",
    parsed.meta ? "meta" : "",
    parsed.alt ? "alt" : "",
    parsed.shift ? "shift" : "",
  ]
    .filter(Boolean)
    .join("+");
}

export const Keyboard = {
  handle(e: KeyboardEvent): void {
    // A blocking dialog is a separate context from the page list, so treat it like a focused text
    // input: global shortcuts that opted out of inputs (delete, Space-complete, arrow nav) stand
    // down, while `allowInInputs` ones (the dialog's own keys, Mod+,) still fire.
    const targetIsEditable = isEditableTarget(e.target) || isBlockingDialogOpen();

    const evt = normalizeEvent(e);

    for (let i = activeScopes.length - 1; i >= 0; i--) {
      const scope = activeScopes[i];
      for (const b of store.values()) {
        if ((b.scope ?? "global") !== scope) continue;
        if (!b.allowInInputs && targetIsEditable) continue;
        if (b.unlessHandled && wasUsed(e)) continue;
        if (b.repeat === false && e.repeat) continue;
        if (b.when && !b.when()) continue;
        if (!matchCombo(evt, b.parsed)) continue;

        if (b.preventDefault !== false) e.preventDefault();
        if (b.stopPropagation) e.stopPropagation();
        try {
          b.handler(e);
        } catch (err) {
          log.error(`Handler failed for ${b.id}`, err);
        }
        return;
      }
    }
  },

  /** Whether a modal dialog or full-window surface is open — for a binding that
   *  reaches into inputs but must still stand down under one. */
  isModalOpen(): boolean {
    return isBlockingDialogOpen();
  },

  listActiveBindings(): Binding[] {
    const activeSet = new Set(activeScopes);
    return Array.from(store.values())
      .filter((b) => activeSet.has(b.scope ?? "global"))
      .map(({ parsed: _p, ...b }) => b);
  },

  /**
   * What the command palette can offer now: labelled bindings in an active scope whose `when()`
   * gate passes. The palette closes before it runs a command, so its own dialog doesn't count as
   * one open over the page here; any other dialog still does.
   */
  listCommands(): Binding[] {
    listingForPalette = true;
    try {
      return Keyboard.listActiveBindings().filter(
        (b) => b.label !== undefined && b.inPalette !== false && (b.when?.() ?? true)
      );
    } finally {
      listingForPalette = false;
    }
  },

  listShortcutCatalog(): ShortcutDoc[] {
    return Array.from(catalog.values());
  },

  /** For an editor plugin that acted on a key, which `unlessHandled` can't otherwise tell. */
  markUsed(e: KeyboardEvent): void {
    usedInEditor.add(e);
  },

  popScope(scope?: string): void {
    if (!scope) {
      activeScopes = activeScopes.slice(0, -1);
      if (!activeScopes.length) activeScopes = ["global"];
      return;
    }
    const idx = activeScopes.lastIndexOf(scope);
    if (idx >= 0) {
      activeScopes.splice(idx, 1);
      if (!activeScopes.length) activeScopes = ["global"];
    }
  },

  pushScope(scope: string): void {
    activeScopes = [...activeScopes, scope];
  },

  register(binding: Binding): void {
    const scope = binding.scope ?? "global";
    const parsed = parseCombo(binding.combo);

    const signature = `${scope}::${conflictKey(parsed)}`;
    for (const b of store.values()) {
      const sig = `${b.scope ?? "global"}::${conflictKey(b.parsed)}`;
      if (sig === signature) {
        log.warn(`Conflict for combo ${binding.combo} in scope ${scope} (existing: ${b.id})`);
      }
    }

    if (binding.label !== undefined) {
      const group = binding.group ?? "Other";
      catalog.set(`${scope}::${binding.combo}::${group}`, {
        combo: binding.combo,
        group,
        label: binding.label,
      });
    }

    store.set(binding.id, { ...binding, parsed, scope });
  },

  setActiveScopes(scopes: string[]): void {
    activeScopes = scopes.length ? [...scopes] : ["global"];
  },

  unregister(id: string): void {
    store.delete(id);
  },
};
