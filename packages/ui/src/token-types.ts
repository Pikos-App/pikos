// The vocabulary the design tokens are written in.
//
// Values are modelled as *data*, never as CSS strings: a hex is a hex, a
// color-mix is a mix node, a shadow is a list of layers. That is what lets a
// second renderer (a native mobile app, a docs site, a Figma export) consume
// `tokens.ts` without parsing CSS — the CSS spelling lives in `css.ts`, which is
// one consumer among several rather than the source of truth.
//
// Relative imports inside this package carry the `.ts` extension on purpose:
// scripts/gen-ui-tokens.mjs loads these modules straight from Node (type
// stripping), and Node's ESM resolver requires the real filename.

/** The two schemes the app renders in. `light` is also the base for anything unthemed. */
export type ColorScheme = "dark" | "light";

export interface HexColor {
  readonly kind: "hex";
  /** Lowercase `#rrggbb`. */
  readonly hex: string;
}

export interface RgbaColor {
  readonly kind: "rgba";
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1. */
  readonly a: number;
}

export interface TransparentColor {
  readonly kind: "transparent";
}

/**
 * A reference to another token by name — `surface-primary`, `color-brand-500`.
 * Modelled explicitly so a non-CSS renderer can resolve it instead of meeting a
 * `var(--…)` string it has no way to interpret.
 */
export interface ColorRef {
  readonly kind: "ref";
  readonly token: string;
}

/** `from` blended `percent`% into `to`. */
export interface ColorMix {
  readonly kind: "mix";
  readonly space: "oklch" | "srgb";
  readonly from: ColorValue;
  readonly percent: number;
  readonly to: ColorValue;
}

export type ColorValue = ColorMix | ColorRef | HexColor | RgbaColor | TransparentColor;

/** Offsets, blur and spread are px; a zero renders unitless. */
export interface ShadowLayer {
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly color: ColorValue;
}

export interface ShadowValue {
  readonly kind: "shadow";
  readonly layers: readonly ShadowLayer[];
}

export type FontFamilyName = "display" | "mono" | "sans";

/** Family names in fallback order, unquoted — the renderer adds quoting. */
export interface FontStackValue {
  readonly kind: "fontStack";
  readonly families: readonly string[];
}

export interface TypeStyleValue {
  readonly kind: "type";
  readonly weight: number;
  readonly sizePx: number;
  /** Unitless multiplier. */
  readonly lineHeight: number;
  readonly family: FontFamilyName;
}

export interface LengthValue {
  readonly kind: "length";
  readonly value: number;
  readonly unit: "em" | "px";
}

export interface TransitionValue {
  readonly kind: "transition";
  readonly durationMs: number;
  readonly easing: string;
}

export type TokenValue =
  | ColorValue
  | FontStackValue
  | LengthValue
  | ShadowValue
  | TransitionValue
  | TypeStyleValue;

export interface TokenDefinition {
  /** CSS custom-property name without the leading `--`. */
  readonly name: string;
  /** The light-scheme value — and the value in both schemes when `dark` is absent. */
  readonly value: TokenValue;
  /** Present only when the dark scheme overrides the token. */
  readonly dark?: TokenValue;
  /** Note rendered above the declaration in the light block. */
  readonly doc?: string;
}

export interface TokenGroup {
  /**
   * Banner lines for this group. `null` means the group continues the previous
   * one with no banner and no separating blank line — how the shadcn aliases,
   * chart and sidebar runs read as a single block in the light scheme while the
   * dark scheme labels the subsets it actually overrides.
   */
  readonly comment: readonly string[] | null;
  /** Banner in the dark block; defaults to `comment`. */
  readonly darkComment?: readonly string[] | null;
  readonly tokens: readonly TokenDefinition[];
}

/** One `--color-x: var(--y)` mapping in the Tailwind bridge. */
export interface TailwindAlias {
  /** Tailwind color name — becomes `--color-<name>`. */
  readonly name: string;
  /** The token it points at. */
  readonly from: string;
}

export interface TailwindAliasGroup {
  readonly comment: readonly string[];
  readonly aliases: readonly TailwindAlias[];
}

// ── Constructors ─────────────────────────────────────────────────────────────

export const hex = (value: string): HexColor => ({ hex: value, kind: "hex" });

export const rgba = (r: number, g: number, b: number, a: number): RgbaColor => ({
  a,
  b,
  g,
  kind: "rgba",
  r,
});

export const transparent: TransparentColor = { kind: "transparent" };

export const ref = (token: string): ColorRef => ({ kind: "ref", token });

export const mix = (
  space: ColorMix["space"],
  from: ColorValue,
  percent: number,
  to: ColorValue
): ColorMix => ({ from, kind: "mix", percent, space, to });

export const shadow = (...layers: readonly ShadowLayer[]): ShadowValue => ({
  kind: "shadow",
  layers,
});

export const layer = (
  x: number,
  y: number,
  blur: number,
  spread: number,
  color: ColorValue
): ShadowLayer => ({ blur, color, spread, x, y });

export const fontStack = (families: readonly string[]): FontStackValue => ({
  families,
  kind: "fontStack",
});

export const typeStyle = (
  weight: number,
  sizePx: number,
  lineHeight: number,
  family: FontFamilyName
): TypeStyleValue => ({ family, kind: "type", lineHeight, sizePx, weight });

export const px = (value: number): LengthValue => ({ kind: "length", unit: "px", value });

export const em = (value: number): LengthValue => ({ kind: "length", unit: "em", value });

export const transition = (durationMs: number, easing: string): TransitionValue => ({
  durationMs,
  easing,
  kind: "transition",
});

/** True for the value kinds that describe a color rather than a metric. */
export function isColorValue(value: TokenValue): value is ColorValue {
  return (
    value.kind === "hex" ||
    value.kind === "rgba" ||
    value.kind === "transparent" ||
    value.kind === "ref" ||
    value.kind === "mix"
  );
}
