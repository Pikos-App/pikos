import "@testing-library/jest-dom/vitest";

import { beforeEach } from "vitest";

// jsdom has no ResizeObserver, and Radix measures its floating layers on mount —
// so rendering any open tooltip/popover/select content throws without this.
globalThis.ResizeObserver ??= class {
  disconnect() {}
  observe() {}
  unobserve() {}
};

// localStorage now persists activeViewId + activePageId across UIProvider mounts;
// reset between tests so each starts from defaults regardless of test order.
beforeEach(() => {
  localStorage.clear();
});
