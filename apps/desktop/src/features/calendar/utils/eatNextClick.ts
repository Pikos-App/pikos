const EAT_CLICK_WINDOW_MS = 200;

/**
 * Swallows the synthetic click a drag/resize mouseup can emit, so it doesn't
 * fall through to whichever block sits under the cursor and open its popover.
 * Call at the end of a drag/resize gesture.
 *
 * The synthetic click belongs to the SAME gesture and fires within a few ms of
 * mouseup. A move-drag (mousedown and mouseup on different targets) often emits
 * NO synthetic click at all — so the guard must not linger and swallow the
 * user's next *deliberate* click (e.g. a block's complete checkbox). That
 * lingering swallow was the "after moving a block, the first checkbox click
 * does nothing" bug. We therefore only eat a click that lands within
 * `EAT_CLICK_WINDOW_MS` of arming; any later click is let through, and the
 * listener tears down on the first click either way.
 *
 * `now` is injectable for tests; defaults to the wall clock.
 */
export function eatNextClick(now: () => number = Date.now): void {
  const armedAt = now();
  function handler(ev: MouseEvent) {
    window.removeEventListener("click", handler, true);
    if (now() - armedAt <= EAT_CLICK_WINDOW_MS) ev.stopPropagation();
  }
  window.addEventListener("click", handler, true);
}
