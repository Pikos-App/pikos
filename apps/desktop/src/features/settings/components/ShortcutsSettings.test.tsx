// The list is derived, so the thing worth pinning is the derivation: a binding
// registered anywhere in the app shows up here, under its own group, and keeps
// showing up after the component that registered it unmounts.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Keyboard } from "@/shared/keyboard/registry";

import { ShortcutsSettings } from "./ShortcutsSettings";

afterEach(() => {
  cleanup();
  Keyboard.unregister("settings-test");
  Keyboard.unregister("settings-test-unlabelled");
});

function group(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const section = heading.parentElement;
  if (!section) throw new Error(`group ${label} has no section`);
  return section;
}

describe("ShortcutsSettings", () => {
  it("renders a registered shortcut under its group", () => {
    Keyboard.register({
      combo: "Mod+Shift+Y",
      group: "Page list",
      handler: () => undefined,
      id: "settings-test",
      label: "Yank the page",
    });

    render(<ShortcutsSettings />);

    const section = group("Page list");
    expect(within(section).getByText("Yank the page")).toBeInTheDocument();
    expect(within(section).getByText("⇧")).toBeInTheDocument();
    expect(within(section).getByText("Y")).toBeInTheDocument();
  });

  it("keeps a shortcut listed after its component unregisters it", () => {
    Keyboard.register({
      combo: "Mod+Shift+Y",
      group: "Page list",
      handler: () => undefined,
      id: "settings-test",
      label: "Yank the page",
    });
    Keyboard.unregister("settings-test");

    render(<ShortcutsSettings />);

    expect(screen.getByText("Yank the page")).toBeInTheDocument();
  });

  it("leaves out a binding with no label", () => {
    Keyboard.register({
      combo: "Mod+Shift+U",
      handler: () => undefined,
      id: "settings-test-unlabelled",
    });

    render(<ShortcutsSettings />);

    expect(screen.queryByText("Mod+Shift+U")).toBeNull();
  });

  it("still lists the keys the editor owns outside the registry", () => {
    render(<ShortcutsSettings />);

    const section = group("Editor");
    expect(within(section).getByText("Bold")).toBeInTheDocument();
    expect(within(section).getByText("Slash menu")).toBeInTheDocument();
  });
});
