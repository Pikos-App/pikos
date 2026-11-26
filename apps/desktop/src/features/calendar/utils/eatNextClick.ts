const EAT_CLICK_WINDOW_MS = 200;

/**
 * Swallows the synthetic click a drag/resize mouseup can emit, so it doesn't fall through to
 * the block under the cursor and open its popover. Call at the end of a gesture.
 *
 * Only a click within `EAT_CLICK_WINDOW_MS` of arming is eaten: a move-drag (press and release
 * on different targets) often emits no synthetic click, and the guard must not linger and
 * swallow the user's next deliberate click, such as a block's checkbox. The listener tears down
 * on the first click either way. `now` is injectable for tests.
 */
export function eatNextClick(now: () => number = Date.now): void {
  const armedAt = now();
  function handler(ev: MouseEvent) {
    window.removeEventListener("click", handler, true);
    if (now() - armedAt <= EAT_CLICK_WINDOW_MS) ev.stopPropagation();
  }
  window.addEventListener("click", handler, true);
}
