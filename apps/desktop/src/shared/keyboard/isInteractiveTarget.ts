// Global shortcuts (Space to toggle done, Up/Down to navigate the page list) work whichever
// non-editable element holds focus, but when the focused element is itself an interactive control
// (button, link, menu item, popover trigger) that control owns the key press, so they stand down.
// Generic containers (role="group", the list wrappers) are not interactive.

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

// A narrower classifier for Arrow-key shortcuts: plain buttons, links and nav rows don't consume
// arrows natively, so list navigation still runs while they hold focus. Only controls that do
// (aria-haspopup triggers, open menus, listboxes, comboboxes, sliders) take priority.
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
