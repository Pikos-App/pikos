import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SyncStatusDot } from "./SyncStatusDot";

afterEach(cleanup);

describe("SyncStatusDot", () => {
  it.each([
    ["active", "Synced"],
    ["off", "Off"],
    ["stale", "Stale"],
    ["error", "Reconnect needed"],
  ] as const)("renders the %s dot with its label", (state, label) => {
    render(<SyncStatusDot label={label} state={state} />);
    expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
  });
});
