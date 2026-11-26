// The web renderer for the design tokens: `tokens.ts` data in, the token tiers of
// apps/desktop/src/app.css out. The output must be prettier-clean (printWidth 100),
// because the prettier gate reads app.css like any other file.

import type { ColorScheme, ColorValue, TokenValue } from "./token-types.ts";
import { PRIMITIVE_GROUPS, SEMANTIC_GROUPS, TAILWIND_ALIAS_GROUPS } from "./tokens.ts";

/** The generator locates the block by this marker's first line. */
export const TOKEN_CSS_START =
  "/* GENERATED: design tokens — emitted from packages/ui/src/tokens.ts by scripts/gen-ui-tokens.mjs.\n" +
  "   Edit the tokens, then re-run the generator; scripts/check-ui-tokens.sh fails the build on drift. */";

export const TOKEN_CSS_END = "/* GENERATED: end design tokens */";

function renderColor(value: ColorValue): string {
  switch (value.kind) {
    case "hex":
      return value.hex;
    case "rgba":
      return `rgba(${value.r}, ${value.g}, ${value.b}, ${value.a})`;
    case "transparent":
      return "transparent";
    case "ref":
      return `var(--${value.token})`;
    case "mix":
      return `color-mix(in ${value.space}, ${renderColor(value.from)} ${value.percent}%, ${renderColor(value.to)})`;
  }
}

const pxOrZero = (n: number): string => (n === 0 ? "0" : `${n}px`);

export function renderValue(value: TokenValue): string {
  switch (value.kind) {
    case "shadow":
      return value.layers
        .map((l) => {
          const parts = [pxOrZero(l.x), pxOrZero(l.y), pxOrZero(l.blur)];
          if (l.spread !== 0) parts.push(pxOrZero(l.spread));
          parts.push(renderColor(l.color));
          return parts.join(" ");
        })
        .join(", ");
    case "fontStack":
      return value.families.map((f) => (f.includes(" ") ? `"${f}"` : f)).join(", ");
    case "type":
      return `${value.weight} ${value.sizePx}px/${value.lineHeight} var(--font-${value.family})`;
    case "length":
      return `${value.value}${value.unit}`;
    case "transition":
      return `${value.durationMs}ms ${value.easing}`;
    default:
      return renderColor(value);
  }
}

const SECTION_RULE = "═".repeat(79);

function section(title: string, body: readonly string[] = []): string[] {
  return [
    `/* ${SECTION_RULE}`,
    `   ${title}`,
    ...body.map((l) => `   ${l}`),
    `   ${SECTION_RULE} */`,
  ];
}

/** Continuation lines align under the first word; the closing rule sits on the last one. */
function groupBanner(lines: readonly string[], rule: string): string[] {
  const indent = "  ";
  const first = lines[0] ?? "";
  if (lines.length === 1) return [`${indent}/* ${rule} ${first} ${rule} */`];
  const pad = " ".repeat(indent.length + 3 + rule.length + 1);
  const out = [`${indent}/* ${rule} ${first}`];
  lines.slice(1).forEach((line, i) => {
    const isLast = i === lines.length - 2;
    out.push(`${pad}${line}${isLast ? ` ${rule} */` : ""}`);
  });
  return out;
}

function renderPrimitives(): string[] {
  const out: string[] = [];
  for (const group of PRIMITIVE_GROUPS) {
    if (out.length > 0) out.push("");
    if (group.comment) out.push(...groupBanner(group.comment, "───"));
    for (const token of group.tokens) out.push(`  --${token.name}: ${renderValue(token.value)};`);
  }
  return out;
}

function renderScheme(scheme: ColorScheme): string[] {
  const out: string[] = [];
  for (const group of SEMANTIC_GROUPS) {
    const comment =
      scheme === "dark" && group.darkComment !== undefined ? group.darkComment : group.comment;
    // The dark block carries overrides only; the rest inherits :root.
    const tokens =
      scheme === "dark" ? group.tokens.filter((t) => t.dark !== undefined) : group.tokens;
    if (tokens.length === 0) continue;
    if (comment) {
      if (out.length > 0) out.push("");
      out.push(...groupBanner(comment, "───"));
    }
    for (const token of tokens) {
      if (scheme === "light" && token.doc) out.push(`  /* ${token.doc} */`);
      const value = scheme === "dark" ? (token.dark ?? token.value) : token.value;
      out.push(`  --${token.name}: ${renderValue(value)};`);
    }
  }
  return out;
}

function renderTailwindBridge(): string[] {
  const out: string[] = [];
  for (const group of TAILWIND_ALIAS_GROUPS) {
    if (out.length > 0) out.push("");
    out.push(...groupBanner(group.comment, "──"));
    for (const a of group.aliases) out.push(`  --color-${a.name}: var(--${a.from});`);
  }
  return out;
}

export function renderTokenCss(): string {
  return [
    ...section("PRIMITIVE COLOR SCALES", [
      "Static values — available as Tailwind utilities (e.g. bg-primary-500).",
      "Do NOT use primitives directly in components — use semantic tokens instead.",
    ]),
    "",
    "@theme {",
    ...renderPrimitives(),
    "}",
    "",
    ...section("SEMANTIC TOKENS — Light Theme", [
      "What colors *mean*, not what they *are*. Use these in components.",
    ]),
    "",
    ":root {",
    ...renderScheme("light"),
    "}",
    "",
    ...section("SEMANTIC TOKENS — Dark Theme"),
    "",
    ".dark {",
    ...renderScheme("dark"),
    "}",
    "",
    ...section("TAILWIND INTEGRATION", [
      "Maps CSS custom properties to Tailwind utilities (responsive to theme).",
    ]),
    "",
    "@theme inline {",
    ...renderTailwindBridge(),
    "}",
  ].join("\n");
}

export function renderTokenCssBlock(): string {
  return `${TOKEN_CSS_START}\n\n${renderTokenCss()}\n\n${TOKEN_CSS_END}`;
}
