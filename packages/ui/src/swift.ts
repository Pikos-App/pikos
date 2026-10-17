// The native renderer for the design tokens: the Swift palette the iOS app and its
// widgets draw with, the asset-catalog colours UIKit reads before any Swift runs,
// and the colour block of the phone editor's stylesheet. All three are committed
// artifacts of `tokens.ts`, regenerated and drift-checked by scripts/gen-ui-tokens.mjs.

import type {
  ColorScheme,
  ColorValue,
  TokenDefinition,
  TokenValue,
  TypeStyleValue,
} from "./token-types.ts";
import { isColorValue } from "./token-types.ts";
import { PRIMITIVE_GROUPS, SEMANTIC_GROUPS, tokenValue } from "./tokens.ts";

/** Straight (not premultiplied) sRGB, each channel 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** The semantic groups a native renderer needs; the rest are web-only aliases. */
export const NATIVE_SEMANTIC_GROUPS = [
  "Identity",
  "Surfaces",
  "Text",
  "Borders",
  "Interactive",
  "Status",
] as const;

const TRANSPARENT: Rgba = { a: 0, b: 0, g: 0, r: 0 };

function parseHex(hex: string): Rgba {
  const n = Number.parseInt(hex.slice(1), 16);
  return { a: 1, b: (n & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, r: ((n >> 16) & 0xff) / 255 };
}

/** CSS `color-mix(in srgb, …)`: interpolated with premultiplied alpha, as the spec requires. */
function mixSrgb(from: Rgba, percent: number, to: Rgba): Rgba {
  const p = percent / 100;
  const a = from.a * p + to.a * (1 - p);
  if (a === 0) return TRANSPARENT;
  const channel = (x: number, y: number) => (x * from.a * p + y * to.a * (1 - p)) / a;
  return { a, b: channel(from.b, to.b), g: channel(from.g, to.g), r: channel(from.r, to.r) };
}

export function resolveColor(value: ColorValue, scheme: ColorScheme): Rgba {
  switch (value.kind) {
    case "hex":
      return parseHex(value.hex);
    case "rgba":
      return { a: value.a, b: value.b / 255, g: value.g / 255, r: value.r / 255 };
    case "transparent":
      return TRANSPARENT;
    case "ref": {
      const target = tokenValue(value.token, scheme);
      if (!isColor(target)) throw new Error(`Token ${value.token} is not a color`);
      return resolveColor(target, scheme);
    }
    case "mix":
      if (value.space !== "srgb") throw new Error(`Only srgb mixes resolve natively`);
      return mixSrgb(
        resolveColor(value.from, scheme),
        value.percent,
        resolveColor(value.to, scheme)
      );
  }
}

function isColor(value: TokenValue): value is ColorValue {
  return isColorValue(value);
}

/** `0xRRGGBBAA`, the literal the Swift palette stores. */
export function rgbaLiteral(color: Rgba): string {
  const byte = (x: number) =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `0x${byte(color.r)}${byte(color.g)}${byte(color.b)}${byte(color.a)}`;
}

function hexLiteral(color: Rgba): string {
  if (color.a !== 1) throw new Error("A stylesheet hex cannot carry alpha");
  return `#${rgbaLiteral(color).slice(2, 8).toLowerCase()}`;
}

/** `surface-primary` → `surfacePrimary`, `color-folder-red` → `folderRed`. */
export function swiftName(tokenName: string): string {
  const parts = tokenName.replace(/^color-/, "").split("-");
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join("");
}

function nativeSemanticTokens(): TokenDefinition[] {
  return NATIVE_SEMANTIC_GROUPS.flatMap((title) => {
    const group = SEMANTIC_GROUPS.find((g) => g.comment?.[0] === title);
    if (!group) throw new Error(`tokens.ts has no semantic group named ${title}`);
    return [...group.tokens];
  });
}

function primitiveGroup(prefix: string): readonly TokenDefinition[] {
  const group = PRIMITIVE_GROUPS.find((g) => g.comment?.[0]?.startsWith(prefix));
  if (!group) throw new Error(`tokens.ts has no primitive group starting ${prefix}`);
  return group.tokens;
}

function typeTokens(): { name: string; style: TypeStyleValue }[] {
  const group = SEMANTIC_GROUPS.find((g) => g.comment?.[0]?.startsWith("Type scale"));
  if (!group) throw new Error("tokens.ts has no type scale");
  return group.tokens.map((t) => {
    if (t.value.kind !== "type") throw new Error(`${t.name} is not a type step`);
    return { name: t.name.replace(/^text-/, "type-"), style: t.value };
  });
}

function lengthPx(name: string): number {
  const value = tokenValue(name, "light");
  if (value.kind !== "length" || value.unit !== "px") throw new Error(`${name} is not a px length`);
  return value.value;
}

function colorPair(token: TokenDefinition): { light: Rgba; dark: Rgba } {
  if (!isColor(token.value)) throw new Error(`${token.name} is not a color`);
  const dark = token.dark ?? token.value;
  if (!isColor(dark)) throw new Error(`${token.name} has a non-color dark value`);
  return { dark: resolveColor(dark, "dark"), light: resolveColor(token.value, "light") };
}

export const SWIFT_TOKENS_PATH = "apps/ios/PikosCore/Sources/PikosSupport/DesignTokens.swift";

export function renderSwiftTokens(): string {
  const color = (token: TokenDefinition) => {
    const { dark, light } = colorPair(token);
    return `    public static let ${swiftName(token.name)} = TokenColor(light: ${rgbaLiteral(light)}, dark: ${rgbaLiteral(dark)})`;
  };
  const type = typeTokens().map(
    ({ name, style }) =>
      `    public static let ${swiftName(name)} = TokenType(size: ${style.sizePx}, weight: ${style.weight}, lineHeight: ${style.lineHeight})`
  );
  const radii = ["radius-sm", "radius-md", "radius-lg", "radius-xl"].map(
    (name) => `    public static let ${swiftName(name)}: Double = ${lengthPx(name)}`
  );

  return [
    "// GENERATED from packages/ui/src/tokens.ts by scripts/gen-ui-tokens.mjs — do not edit.",
    "",
    "public enum PikosToken {",
    ...nativeSemanticTokens().map(color),
    "",
    ...primitiveGroup("Folder").map(color),
    "",
    ...primitiveGroup("Status colors").map(color),
    "",
    ...type,
    "",
    ...radii,
    "}",
    "",
  ].join("\n");
}

export interface AssetColor {
  /** Path of the colour set's Contents.json, relative to the repo root. */
  readonly path: string;
  readonly contents: string;
}

const ASSET_ROOTS = ["apps/ios/Pikos/Sources/Assets.xcassets"] as const;

function colorSetJson(light: Rgba, dark: Rgba): string {
  const components = (c: Rgba) => ({
    alpha: c.a.toFixed(3),
    blue: `0x${rgbaLiteral(c).slice(6, 8)}`,
    green: `0x${rgbaLiteral(c).slice(4, 6)}`,
    red: `0x${rgbaLiteral(c).slice(2, 4)}`,
  });
  const entry = (c: Rgba, appearance?: "dark") => ({
    ...(appearance ? { appearances: [{ appearance: "luminosity", value: appearance }] } : {}),
    color: { "color-space": "srgb", components: components(c) },
    idiom: "universal",
  });
  // Xcode writes these with " : " separators; matching it keeps an Xcode save a no-op.
  return `${JSON.stringify(
    { colors: [entry(light), entry(dark, "dark")], info: { author: "xcode", version: 1 } },
    null,
    2
  ).replace(/": /g, '" : ')}\n`;
}

/** `AccentColor` tints every system control, whose labels are text; `LaunchBackground` paints the launch screen. */
export function renderAssetColors(): AssetColor[] {
  const sets = [
    { name: "AccentColor", token: "text-action" },
    { name: "LaunchBackground", token: "surface-primary" },
  ];
  return ASSET_ROOTS.flatMap((root) =>
    sets.map(({ name, token }) => {
      const definition = nativeSemanticTokens().find((t) => t.name === token)!;
      const { dark, light } = colorPair(definition);
      return {
        contents: colorSetJson(light, dark),
        path: `${root}/${name}.colorset/Contents.json`,
      };
    })
  );
}

export const EDITOR_CSS_PATH = "packages/editor-mobile/src/editor.css";
export const EDITOR_CSS_START =
  "/* GENERATED: colors — emitted from packages/ui/src/tokens.ts by scripts/gen-ui-tokens.mjs. */";
export const EDITOR_CSS_END = "/* GENERATED: end colors */";

const EDITOR_VARIABLES = [
  ["--pikos-accent", "text-action"],
  ["--pikos-bg", "surface-primary"],
  ["--pikos-fg", "text-primary"],
  ["--pikos-muted", "text-tertiary"],
  ["--pikos-rule", "border-secondary"],
  ["--pikos-inset", "surface-inset"],
  ["--pikos-check", "border-primary"],
  ["--pikos-selection", "surface-selected"],
] as const;

/** Editor colours as custom properties, both schemes; alpha tokens render as rgba(). */
export function renderEditorCssBlock(): string {
  const value = (token: string, scheme: ColorScheme) => {
    const definition = nativeSemanticTokens().find((t) => t.name === token);
    if (!definition) throw new Error(`No native token ${token}`);
    const { dark, light } = colorPair(definition);
    const c = scheme === "dark" ? dark : light;
    if (c.a === 1) return hexLiteral(c);
    const byte = (x: number) => Math.round(x * 255);
    return `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${Number(c.a.toFixed(3))})`;
  };
  const block = (selector: string, scheme: ColorScheme) => [
    `${selector} {`,
    ...EDITOR_VARIABLES.map(([name, token]) => `  ${name}: ${value(token, scheme)};`),
    "}",
  ];
  // The system's scheme until the host sends its own: the page draws before the host can, and a
  // light background there flashed white as a dark-mode page opened.
  const followingSystem = [
    "@media (prefers-color-scheme: dark) {",
    ...block(':root:not([data-scheme="light"])', "dark").map((line) => `  ${line}`),
    "}",
  ];
  return [
    EDITOR_CSS_START,
    ...block(":root", "light"),
    "",
    ...followingSystem,
    "",
    ...block(':root[data-scheme="dark"]', "dark"),
    EDITOR_CSS_END,
  ].join("\n");
}
