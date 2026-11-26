import "@testing-library/jest-dom/vitest";

import { beforeEach } from "vitest";

// jsdom has no ResizeObserver, and Radix measures its floating layers on mount.
globalThis.ResizeObserver ??= class {
  disconnect() {}
  observe() {}
  unobserve() {}
};

// jsdom ships PointerEvent but not pointer capture, which the calendar's resize handles use. A
// test dispatching at the handle already reaches those listeners, so the stand-ins only need to
// exist. Assigned through an index signature because reading `Element.prototype.setPointerCapture`
// trips the unbound-method rule.
const elementProto = Element.prototype as unknown as Record<string, unknown>;
elementProto["setPointerCapture"] ??= () => {};
elementProto["releasePointerCapture"] ??= () => {};
elementProto["hasPointerCapture"] ??= () => false;

// localStorage persists activeViewId + activePageId across UIProvider mounts; reset so each test
// starts from defaults.
beforeEach(() => {
  localStorage.clear();
});
