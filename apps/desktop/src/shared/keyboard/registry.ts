import { IS_MACOS } from "@/shared/constants/platform";
import { createLogger } from "@/shared/logger";

const log = createLogger("Keyboard");

export type Binding = {
  id: string;
  combo: string; // e.g., "Mod+Shift+D"
  scope?: string; // default: "global"
  // The originating KeyboardEvent is passed so handlers can branch on e.g.
  // `e.repeat`. Handlers that don't need it can ignore the argument.
  handler: (e: KeyboardEvent) => void;
  when?: () => boolean;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  repeat?: boolean; // default false -> ignore auto-repeat
  allowInInputs?: boolean; // default false
};

export type NormalizedCombo = {
  key: string; // lowercase key
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
  return lower;
}

function parseCombo(combo: string): NormalizedCombo {
  // Accept forms like "Mod+Shift+D" or "Cmd+Shift+D" or "Ctrl+D"
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
    // Mod maps to Meta on macOS and Control elsewhere
    mod: IS_MACOS ? e.metaKey : e.ctrlKey,
    shift: e.shiftKey,
  };
}

function matchCombo(evt: NormalizedCombo, bind: NormalizedCombo): boolean {
  if (evt.key !== bind.key) return false;

  // Alt and Shift must match exactly
  if (evt.alt !== bind.alt) return false;
  if (evt.shift !== bind.shift) return false;

  if (bind.mod) {
    // Require the platform "mod" key to be held (Cmd on mac, Ctrl otherwise)
    if (!evt.mod) return false;
    // When using Mod, don't additionally require explicit ctrl/meta flags.
  } else {
    // No Mod: explicit ctrl/meta must match exactly
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
// Covers both the shadcn Dialog and AlertDialog families via their slot names.
function isBlockingDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector(
      '[data-slot="dialog-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"]'
    ) !== null
  );
}

const store = new Map<string, Binding & { parsed: NormalizedCombo }>();
let activeScopes: string[] = ["global"]; // top is last

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
    // Focus guard. A blocking dialog puts the user in a separate mental
    // context (the activePage / page list isn't what they're acting on), so
    // treat "a modal dialog is open" exactly like "a text input is focused":
    // global shortcuts that opted out of inputs (delete, Space-complete, arrow
    // nav) stand down, while `allowInInputs` shortcuts (the dialog's own keys,
    // Mod+, etc.) still fire. Prevents accidental page deletes after clicking
    // a button inside a dialog.
    const targetIsEditable = isEditableTarget(e.target) || isBlockingDialogOpen();

    const evt = normalizeEvent(e);

    // Evaluate scopes from top-most down (last is top)
    for (let i = activeScopes.length - 1; i >= 0; i--) {
      const scope = activeScopes[i];
      for (const b of store.values()) {
        if ((b.scope ?? "global") !== scope) continue;
        if (!b.allowInInputs && targetIsEditable) continue;
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
        return; // stop at first match in current top scope
      }
    }
  },

  listActiveBindings(): Binding[] {
    const activeSet = new Set(activeScopes);
    return Array.from(store.values())
      .filter((b) => activeSet.has(b.scope ?? "global"))
      .map(({ parsed: _p, ...b }) => b);
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

    store.set(binding.id, { ...binding, parsed, scope });
  },

  setActiveScopes(scopes: string[]): void {
    activeScopes = scopes.length ? [...scopes] : ["global"];
  },

  unregister(id: string): void {
    store.delete(id);
  },
};
