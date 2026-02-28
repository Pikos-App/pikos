---
name: keyboard-shortcut
description: How to add keyboard shortcuts in the Pikos Tauri app. Distinguishes between in-app shortcuts (JS registry), native menu shortcuts (Tauri menu API + event listeners), and global OS shortcuts. Use when adding any new keyboard binding.
compatibility: Tauri v2, @tauri-apps/api/event
---

# Add a Keyboard Shortcut

## Three mechanisms — use the right one

| Type | Mechanism | Use for |
|------|-----------|---------|
| In-app shortcuts | JS registry (`registry.ts`) | Shortcuts with no native menu item |
| Native menu shortcuts | Tauri menu API → Tauri event → frontend listener | Anything with a menu bar entry |
| Global OS shortcuts | `tauri-plugin-global-shortcut` | Fires even when app not focused (e.g. quick capture) |

**Never register a native menu shortcut in the JS registry.** On macOS the OS intercepts
native menu shortcuts before they reach the DOM — double-registering causes missed or doubled
events depending on platform behaviour.

## Adding an in-app shortcut (no menu item)

All in-app shortcuts live in `apps/desktop/src/shared/keyboard/actions.ts`.

```typescript
import { Keyboard } from './registry'

Keyboard.register({
  id: 'my-action',           // unique string ID
  combo: 'Mod+Shift+K',      // Mod = Cmd on macOS, Ctrl elsewhere
  scope: 'global',           // 'global' | 'editor' | 'modal'
  handler: () => { /* ... */ },
  preventDefault: true,
  repeat: false,             // false = ignore key-repeat events
  allowInInputs: false,      // true = fires even when user is typing
})
```

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

## Hook usage in React components

```typescript
import { useKeyboardShortcut } from '@/shared/keyboard/useKeyboard'

function MyComponent() {
  useKeyboardShortcut('Escape', () => closeModal(), { scope: 'modal' })
}
```

Registers on mount, unregisters on unmount automatically.

## Scope rules

- `global` — always active when app is focused
- `editor` — only when Tiptap editor is focused (push on focus, pop on blur)
- `modal` — only when a modal is open (push when modal opens, pop on close)

## The `Mod` abstraction

Use `Mod+` for cross-platform. Resolves to `Cmd` on macOS, `Ctrl` on Windows/Linux.

## Existing shortcuts (don't conflict)

| Combo | Action | Mechanism |
|-------|--------|-----------|
| Mod+P | Command palette | JS registry |
| Mod+Shift+D | Delete page | JS registry |
| Mod+Shift+M | Toggle metadata header | JS registry |
| Mod+Shift+C | Toggle calendar/editor view | JS registry |
| `[` / `]` | Calendar prev/next day | JS registry |
| `t` | Calendar — jump to today | JS registry (global scope; `allowInInputs: false`) |
| Mod+N | New page | Native menu (GOO-24) — not in JS registry |
| Mod+W | Close page | Native menu (GOO-24) — not in JS registry |
| Mod+, | Settings | Native menu (GOO-24) — not in JS registry |
