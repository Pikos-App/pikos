// Shared focus-target classifier for global keyboard shortcuts.
//
// Some shortcuts (Space to toggle done, Up/Down to navigate the page list) are
// registered globally so they work regardless of which non-editable element
// holds focus. But when the focused element is itself an interactive control —
// a button, link, menu item, or popover/dropdown trigger — that control should
// own the key press (Space activates it, Arrow keys move within its menu). This
// guard lets those shortcuts stand down so the focused control takes priority.
//
// Generic containers (role="group", the page/folder list wrappers) are NOT
// interactive, so arrow navigation still works while they hold focus.

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "select",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
].join(", ");

export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(INTERACTIVE_SELECTOR) != null;
}

// A narrower classifier for Arrow-key shortcuts. Plain buttons, links, and the
// folder/page nav rows do NOT respond to arrow keys natively, so arrow-driven
// list navigation should still run while they hold focus. Only controls that
// natively consume arrows — popover/menu triggers (aria-haspopup), open menus,
// listboxes, comboboxes, sliders, etc. — should take priority.
const ARROW_CONSUMER_SELECTOR = [
  '[aria-haspopup]:not([aria-haspopup="false"])',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="grid"]',
  '[role="tree"]',
  '[role="treeitem"]',
  '[role="tablist"]',
  '[role="tab"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="radiogroup"]',
  '[role="radio"]',
].join(", ");

export function isArrowKeyConsumer(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(ARROW_CONSUMER_SELECTOR) != null;
}
