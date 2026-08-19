import { describe, expect, it } from "vitest";

import { renderTokenCss, renderValue } from "./css.ts";
import type { TokenValue } from "./token-types.ts";
import { isColorValue } from "./token-types.ts";
import {
  PRIMITIVES,
  SEMANTIC_GROUPS,
  SEMANTIC_TOKENS,
  TAILWIND_ALIAS_GROUPS,
  tokenHex,
  tokenValue,
} from "./tokens.ts";

/** Every value node reachable from a token, including mix operands and shadow layers. */
function walk(value: TokenValue): TokenValue[] {
  if (value.kind === "mix") return [value, ...walk(value.from), ...walk(value.to)];
  if (value.kind === "shadow") return [value, ...value.layers.flatMap((l) => walk(l.color))];
  return [value];
}

const semanticValues = [...SEMANTIC_TOKENS.values()].flatMap((t) =>
  t.dark === undefined ? [t.value] : [t.value, t.dark]
);

describe("CSS rendering", () => {
  it("renders each value kind the way app.css spells it", () => {
    expect(renderValue(tokenValue("color-brand-500", "light"))).toBe("#a65544");
    expect(renderValue(tokenValue("surface-selected", "dark"))).toBe(
      "color-mix(in srgb, #2dd4a8 12%, transparent)"
    );
    expect(renderValue(tokenValue("shadow-app-popover", "light"))).toBe(
      "0 4px 16px rgba(0, 0, 0, 0.12), 0 0 0 1px var(--border-primary)"
    );
    expect(renderValue(tokenValue("text-display", "light"))).toBe(
      "500 24px/1.3 var(--font-display)"
    );
    expect(renderValue(tokenValue("font-mono", "light"))).toBe(
      '"SF Mono", ui-monospace, monospace'
    );
    expect(renderValue(tokenValue("tracking-tight", "light"))).toBe("-0.02em");
    expect(renderValue(tokenValue("transition-fast", "light"))).toBe("120ms ease");
    expect(renderValue(tokenValue("titlebar-border", "dark"))).toBe("rgba(255, 255, 255, 0.07)");
  });

  it("emits the three tiers in the order app.css declares them", () => {
    const css = renderTokenCss();
    const order = ["@theme {", ":root {", ".dark {", "@theme inline {"].map((s) => css.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(css).toContain("  --color-brand-500: #a65544;");
    expect(css).toContain("  --surface-primary: #ffffff;");
    expect(css).toContain("  --color-surface-primary: var(--surface-primary);");
  });
});

describe("light / dark completeness", () => {
  it("gives every literal color and shadow an explicit dark value", () => {
    const missing = [...SEMANTIC_TOKENS.values()]
      .filter((t) => t.dark === undefined)
      .filter((t) => t.value.kind === "shadow" || (isColorValue(t.value) && t.value.kind !== "ref"))
      .map((t) => t.name);
    // A semantic token holding a literal is scheme-specific by definition; only
    // aliases (refs) and the unthemed metrics may inherit :root in dark mode.
    expect(missing).toEqual([]);
  });

  it("resolves every semantic token in both schemes", () => {
    for (const name of SEMANTIC_TOKENS.keys()) {
      expect(tokenValue(name, "light")).toBeDefined();
      expect(tokenValue(name, "dark")).toBeDefined();
    }
  });

  it("resolves the surface color the theme-color meta tag uses", () => {
    expect(tokenHex("surface-primary", "light")).toBe("#ffffff");
    expect(tokenHex("surface-primary", "dark")).toBe("#161613");
    expect(tokenHex("brand-identity", "light")).toBe("#a65544");
    expect(tokenHex("brand-identity", "dark")).toBe("#c06a58");
  });
});

describe("tier discipline", () => {
  it("reaches primitives only through modelled refs, never through raw CSS", () => {
    for (const value of semanticValues.flatMap(walk)) {
      for (const field of Object.values(value)) {
        if (typeof field !== "string") continue;
        expect(field).not.toContain("var(");
        expect(field).not.toContain("--");
        expect(field).not.toContain("color-mix(");
      }
    }
  });

  it("points every ref at a token that exists", () => {
    for (const value of semanticValues.flatMap(walk)) {
      if (value.kind !== "ref") continue;
      expect(PRIMITIVES.has(value.token) || SEMANTIC_TOKENS.has(value.token)).toBe(true);
    }
  });

  it("keeps the Tailwind bridge pointed at semantic tokens only", () => {
    for (const group of TAILWIND_ALIAS_GROUPS) {
      for (const alias of group.aliases) {
        expect(SEMANTIC_TOKENS.has(alias.from)).toBe(true);
        expect(PRIMITIVES.has(alias.from)).toBe(false);
      }
    }
  });

  it("declares each token name exactly once", () => {
    const names = SEMANTIC_GROUPS.flatMap((g) => g.tokens.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });
});
