import "@testing-library/jest-dom/vitest";

import { beforeEach } from "vitest";

// localStorage now persists activeViewId + activePageId across UIProvider mounts;
// reset between tests so each starts from defaults regardless of test order.
beforeEach(() => {
  localStorage.clear();
});
