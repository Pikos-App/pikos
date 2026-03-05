---
name: keyboard-shortcut
description: How to add keyboard shortcuts in the Pikos Tauri app. Distinguishes between in-app shortcuts (React hooks → JS registry), native menu shortcuts (Tauri menu API + event listeners), and global OS shortcuts. Use when adding any new keyboard binding.
compatibility: Tauri v2, @tauri-apps/api/event
---

# Add a Keyboard Shortcut

## Three mechanisms — use the right one

| Type | Mechanism | Use for |
|------|-----------|---------|
| In-app shortcuts | `useKeyboardShortcut` hook → `registry.ts` | Shortcuts with no native menu item |
| Native menu shortcuts | Tauri menu API → Tauri event → frontend listener | Anything with a menu bar entry |
| Global OS shortcuts | `tauri-plugin-global-shortcut` | Fires even when app not focused (e.g. quick capture) |

**Never register a native menu shortcut in the JS registry.** On macOS the OS intercepts
native menu shortcuts before they reach the DOM — double-registering causes missed or doubled
events depending on platform behaviour.

---

## Adding an in-app shortcut

Use `useKeyboardShortcut` in the component that owns the action. It registers on mount and
unregisters on unmount automatically. Never call `Keyboard.register()` directly in React code.

```typescript
import { useKeyboardShortcut } from '@/shared/keyboard/useKeyboard'

function MyComponent() {
  useKeyboardShortcut(
    'Mod+Shift+K',          // Mod = Cmd on macOS, Ctrl elsewhere
    () => doSomething(),
    {
      scope: 'global',      // 'global' | 'editor' | 'modal' (default: 'global')
      preventDefault: true, // default true
      repeat: false,        // false = ignore key-repeat events (default false)
      allowInInputs: false, // true = fires even when user is typing (default false)
    }
  )
}
```

### Chord shortcut (two-key sequence)

Pass a tuple — second key must be pressed within 400 ms of the first.

```typescript
useKeyboardShortcut(['Mod+K', 'Mod+O'], () => openSomething())
```

The first key arms a transient scope; the second key fires the handler. Any other key
or a 400 ms timeout cancels the chord silently.

---

## Scope isolation (modals, dialogs)

Push a scope on open, pop on close. Shortcuts in lower scopes are suppressed while a
higher scope is active.

```typescript
import { useKeyboardScope, useKeyboardShortcut } from '@/shared/keyboard/useKeyboard'

function MyModal({ onClose }: { onClose: () => void }) {
  useKeyboardScope('modal')  // pushed on mount, popped on unmount
  useKeyboardShortcut('Escape', onClose, { scope: 'modal' })
}
```

Scope names are freeform strings. The built-in conventions are:

- `global` — always active when app is focused
- `editor` — only when Tiptap editor has focus (push on focus, pop on blur)
- `modal` — only when a modal/dialog is open

---

## Adding a native menu shortcut

Native menu shortcuts are owned by the OS. Register the shortcut in the Tauri menu
definition (GOO-24), then handle the menu event on the frontend:

```typescript
// In App.tsx or a dedicated menu listener
import { listen } from '@tauri-apps/api/event'

listen('menu:new-page', () => createPage())
listen('menu:close-page', () => setActivePage(null))
```

On the Rust side (`apps/desktop/src-tauri/src/menu.rs`):
```rust
MenuItemBuilder::new("New Page")
  .accelerator("CmdOrCtrl+N")
  .id("new-page")
  .build(app)?
```

---

## `actions.ts` — combo constants for display only

`apps/desktop/src/shared/keyboard/actions.ts` exports combo strings used for UI labels
(e.g. tooltip "⌘N"). They are **not** registrations — do not pass them to
`useKeyboardShortcut` if the shortcut is a native menu item.

```typescript
export const shortcuts = {
  newFile: "Mod+N",       // native menu — display label only, NOT in JS registry
  deleteFile: "Mod+Shift+D",
  closeFile: "Mod+W",     // native menu — display label only, NOT in JS registry
  pageSwitcher: "Mod+P",
} as const
```

---

## `useKeyboardListener` — already wired

`useKeyboardListener()` is called once in `App.tsx` (inside `<AppShell>`). It attaches
the global `keydown` listener that routes events through the registry. **Do not call it
again** in any other component.

---

## Existing shortcuts (don't conflict)

| Combo | Action | Mechanism | Status |
|-------|--------|-----------|--------|
| Mod+P | Command palette | JS registry | planned |
| Mod+Shift+D | Delete page | JS registry | planned |
| Mod+Shift+M | Toggle metadata header | JS registry | planned |
| Mod+Shift+C | Toggle calendar/editor view | JS registry | planned |
| Mod+\ | Toggle sidebar collapse | JS registry | planned (GOO-80) |
| J / K | Prev/next page | JS registry | planned (GOO-80) |
| `[` / `]` | Calendar prev/next day | JS registry | planned |
| `t` | Calendar — jump to today | JS registry (`allowInInputs: false`) | planned |
| Mod+N | New page | Native menu (GOO-24) — not in JS registry | planned |
| Mod+W | Close page | Native menu (GOO-24) — not in JS registry | planned |
| Mod+, | Settings | Native menu (GOO-24) — not in JS registry | planned |
