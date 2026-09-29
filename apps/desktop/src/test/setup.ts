import "@testing-library/jest-dom/vitest";

import { beforeEach } from "vitest";

// jsdom has no ResizeObserver, and Radix measures its floating layers on mount —
// so rendering any open tooltip/popover/select content throws without this.
globalThis.ResizeObserver ??= class {
  disconnect() {}
  observe() {}
  unobserve() {}
};

// jsdom ships the PointerEvent constructor but not pointer capture, which the
// calendar's resize handles use to keep receiving moves after the pointer
// leaves the 3px bar. Capture is a routing concern there is no compositor for
// here, and a test dispatching at the handle already reaches those listeners —
// so the stand-ins only need to exist, and to agree that nothing is captured.
//
// Assigned through an index signature rather than the typed prototype: reading
// `Element.prototype.setPointerCapture` to test it for absence is exactly what
// the unbound-method rule exists to catch.
const elementProto = Element.prototype as unknown as Record<string, unknown>;
elementProto["setPointerCapture"] ??= () => {};
elementProto["releasePointerCapture"] ??= () => {};
elementProto["hasPointerCapture"] ??= () => false;

// localStorage now persists activeViewId + activePageId across UIProvider mounts;
// reset between tests so each starts from defaults regardless of test order.
beforeEach(() => {
  localStorage.clear();
});
