// SyncSourceIcon — the provenance glyph for a synced page. Three branches:
// native (null → nothing), active mirror, detached mirror.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SyncSourceIcon } from "./SyncSourceIcon";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

describe("SyncSourceIcon", () => {
  it("renders nothing for a native page (null syncState)", () => {
    const { container } = render(<SyncSourceIcon syncState={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the active-mirror glyph for an active synced page", () => {
    render(<SyncSourceIcon syncState="active" />);
    expect(screen.getByLabelText("Synced from external calendar")).toBeInTheDocument();
  });

  it("renders the broken-calendar glyph for a detached synced page", () => {
    render(<SyncSourceIcon syncState="detached" />);
    expect(screen.getByLabelText("Disconnected from calendar")).toBeInTheDocument();
  });
});
