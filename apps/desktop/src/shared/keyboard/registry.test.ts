import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Keyboard } from "./registry";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeKeyEvent(
  key: string,
  opts: {
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    repeat?: boolean;
    shiftKey?: boolean;
    target?: EventTarget;
  } = {}
): KeyboardEvent {
  return {
    altKey: opts.altKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    key,
    metaKey: opts.metaKey ?? false,
    preventDefault: vi.fn(),
    repeat: opts.repeat ?? false,
    shiftKey: opts.shiftKey ?? false,
    stopPropagation: vi.fn(),
    target: opts.target ?? document.createElement("div"),
  } as unknown as KeyboardEvent;
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset scopes to default
  Keyboard.setActiveScopes(["global"]);
});

afterEach(() => {
  // Unregister all test bindings
  for (const b of Keyboard.listActiveBindings()) {
    Keyboard.unregister(b.id);
  }
  Keyboard.setActiveScopes(["global"]);
});

// ─── Basic registration and handling ─────────────────────────────────────────

describe("register + handle", () => {
  it("fires handler for matching combo", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+d", handler, id: "test-mod-d" });

    // On non-Mac, Mod = Ctrl
    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not fire handler for non-matching combo", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+d", handler, id: "test-mod-d" });

    Keyboard.handle(makeKeyEvent("e", { ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls preventDefault by default", () => {
    Keyboard.register({ combo: "Mod+s", handler: vi.fn(), id: "test-mod-s" });

    const pd = vi.fn();
    const event = makeKeyEvent("s", { ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: pd });
    Keyboard.handle(event);
    expect(pd).toHaveBeenCalled();
  });

  it("respects preventDefault: false", () => {
    Keyboard.register({
      combo: "Mod+s",
      handler: vi.fn(),
      id: "test-mod-s",
      preventDefault: false,
    });

    const pd = vi.fn();
    const event = makeKeyEvent("s", { ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: pd });
    Keyboard.handle(event);
    expect(pd).not.toHaveBeenCalled();
  });

  it("stopPropagation when configured", () => {
    Keyboard.register({
      combo: "Mod+s",
      handler: vi.fn(),
      id: "test-mod-s",
      stopPropagation: true,
    });

    const sp = vi.fn();
    const event = makeKeyEvent("s", { ctrlKey: true });
    Object.defineProperty(event, "stopPropagation", { value: sp });
    Keyboard.handle(event);
    expect(sp).toHaveBeenCalled();
  });
});

// ─── Scope push/pop ordering ─────────────────────────────────────────────────

describe("scope push/pop", () => {
  it("top scope handler takes priority", () => {
    const globalHandler = vi.fn();
    const modalHandler = vi.fn();

    Keyboard.register({
      combo: "Escape",
      handler: globalHandler,
      id: "global-esc",
      scope: "global",
    });
    Keyboard.register({ combo: "Escape", handler: modalHandler, id: "modal-esc", scope: "modal" });
    Keyboard.pushScope("modal");

    Keyboard.handle(makeKeyEvent("Escape"));
    expect(modalHandler).toHaveBeenCalledOnce();
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it("falls through to lower scope when top has no match", () => {
    const globalHandler = vi.fn();
    Keyboard.register({ combo: "Mod+d", handler: globalHandler, id: "global-d", scope: "global" });
    Keyboard.pushScope("modal");

    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true }));
    expect(globalHandler).toHaveBeenCalledOnce();
  });

  it("popScope removes specific scope", () => {
    const modalHandler = vi.fn();
    Keyboard.register({ combo: "Escape", handler: modalHandler, id: "modal-esc", scope: "modal" });
    Keyboard.pushScope("modal");

    Keyboard.popScope("modal");
    Keyboard.handle(makeKeyEvent("Escape"));
    expect(modalHandler).not.toHaveBeenCalled();
  });

  it("popScope without arg removes top scope", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Escape", handler, id: "panel-esc", scope: "panel" });
    Keyboard.pushScope("panel");

    Keyboard.popScope();
    Keyboard.handle(makeKeyEvent("Escape"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("always retains global scope as fallback", () => {
    Keyboard.popScope(); // pop the only scope
    const handler = vi.fn();
    Keyboard.register({ combo: "Escape", handler, id: "global-esc" });
    Keyboard.handle(makeKeyEvent("Escape"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ─── Repeat suppression ─────────────────────────────────────────────────────

describe("repeat", () => {
  it("suppresses auto-repeat when repeat: false is explicit", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+s", handler, id: "test-repeat", repeat: false });

    Keyboard.handle(makeKeyEvent("s", { ctrlKey: true, repeat: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows auto-repeat by default (repeat undefined)", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+s", handler, id: "test-repeat-default" });

    Keyboard.handle(makeKeyEvent("s", { ctrlKey: true, repeat: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("allows auto-repeat when repeat: true", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+s", handler, id: "test-repeat", repeat: true });

    Keyboard.handle(makeKeyEvent("s", { ctrlKey: true, repeat: true }));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ─── allowInInputs ──────────────────────────────────────────────────────────

describe("allowInInputs", () => {
  it("blocks handler when target is editable by default", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+d", handler, id: "test-input" });

    const input = document.createElement("input");
    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true, target: input }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("fires handler in editable when allowInInputs: true", () => {
    const handler = vi.fn();
    Keyboard.register({
      allowInInputs: true,
      combo: "Mod+d",
      handler,
      id: "test-input-allow",
    });

    const input = document.createElement("input");
    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true, target: input }));
    expect(handler).toHaveBeenCalledOnce();
  });

  // jsdom does not implement isContentEditable — this is tested via E2E instead
  it.skip("blocks handler when target is contenteditable", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+d", handler, id: "test-ce" });

    const div = document.createElement("div");
    div.contentEditable = "true";
    document.body.appendChild(div);
    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true, target: div }));
    expect(handler).not.toHaveBeenCalled();
    document.body.removeChild(div);
  });
});

// ─── when conditional ───────────────────────────────────────────────────────

describe("when conditional", () => {
  it("skips handler when when() returns false", () => {
    const handler = vi.fn();
    Keyboard.register({
      combo: "Mod+d",
      handler,
      id: "test-when",
      when: () => false,
    });

    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("fires handler when when() returns true", () => {
    const handler = vi.fn();
    Keyboard.register({
      combo: "Mod+d",
      handler,
      id: "test-when",
      when: () => true,
    });

    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true }));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ─── Modifier matching ──────────────────────────────────────────────────────

describe("modifier matching", () => {
  it("Alt must match exactly", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Alt+d", handler, id: "test-alt" });

    Keyboard.handle(makeKeyEvent("d", { altKey: false }));
    expect(handler).not.toHaveBeenCalled();

    Keyboard.handle(makeKeyEvent("d", { altKey: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("Shift must match exactly", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Shift+d", handler, id: "test-shift" });

    Keyboard.handle(makeKeyEvent("d", { shiftKey: false }));
    expect(handler).not.toHaveBeenCalled();

    Keyboard.handle(makeKeyEvent("d", { shiftKey: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("Mod+Shift combo requires both", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+Shift+c", handler, id: "test-mod-shift" });

    // Only Mod, no Shift
    Keyboard.handle(makeKeyEvent("c", { ctrlKey: true, shiftKey: false }));
    expect(handler).not.toHaveBeenCalled();

    // Both Mod + Shift
    Keyboard.handle(makeKeyEvent("c", { ctrlKey: true, shiftKey: true }));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ─── unregister ─────────────────────────────────────────────────────────────

describe("unregister", () => {
  it("removes binding so handler no longer fires", () => {
    const handler = vi.fn();
    Keyboard.register({ combo: "Mod+d", handler, id: "test-unreg" });
    Keyboard.unregister("test-unreg");

    Keyboard.handle(makeKeyEvent("d", { ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── listActiveBindings ─────────────────────────────────────────────────────

describe("listActiveBindings", () => {
  it("returns bindings in active scopes only", () => {
    Keyboard.register({ combo: "Mod+a", handler: vi.fn(), id: "g1", scope: "global" });
    Keyboard.register({ combo: "Mod+b", handler: vi.fn(), id: "m1", scope: "modal" });

    // Only global scope is active
    const active = Keyboard.listActiveBindings();
    expect(active.map((b) => b.id)).toContain("g1");
    expect(active.map((b) => b.id)).not.toContain("m1");

    // Push modal scope
    Keyboard.pushScope("modal");
    const activeWithModal = Keyboard.listActiveBindings();
    expect(activeWithModal.map((b) => b.id)).toContain("g1");
    expect(activeWithModal.map((b) => b.id)).toContain("m1");
  });
});
