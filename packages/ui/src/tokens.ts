// Pikos design tokens — the single source of truth for every color, type step,
// radius and shadow the product uses.
//
// Three tiers, same as the CSS they generate:
//   1. PRIMITIVE_GROUPS — the raw scales. Never referenced from a component.
//   2. SEMANTIC_GROUPS  — what a color *means*, per scheme. This is the tier
//                         components (and a future native renderer) consume.
//   3. TAILWIND_ALIAS_GROUPS — the web-only bridge that exposes tier 2 as
//                         Tailwind utilities.
//
// apps/desktop/src/app.css does not own these values any more: the token tiers
// of that file are emitted from here by scripts/gen-ui-tokens.mjs, and
// scripts/check-ui-tokens.sh fails the build if the two drift apart.

import {
  type ColorScheme,
  em,
  fontStack,
  hex,
  layer,
  mix,
  px,
  ref,
  rgba,
  shadow,
  type TailwindAliasGroup,
  type TokenDefinition,
  type TokenGroup,
  type TokenValue,
  transition,
  transparent,
  typeStyle,
} from "./token-types.ts";

/** `--color-<prefix>-<stop>` for each stop, in the order given. */
function scale(
  prefix: string,
  stops: readonly (readonly [number | string, string])[]
): readonly TokenDefinition[] {
  return stops.map(([stop, value]) => ({ name: `color-${prefix}-${stop}`, value: hex(value) }));
}

/** `--<name>: var(--<from>)` — an alias that carries no value of its own. */
function alias(name: string, from: string): TokenDefinition {
  return { name, value: ref(from) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 1 — primitives
// ═══════════════════════════════════════════════════════════════════════════════

export const PRIMITIVE_GROUPS: readonly TokenGroup[] = [
  {
    comment: [
      "Brand — terracotta. Identity only (app icon, About screen).",
      "Never on interactive UI — that's primary-*.",
    ],
    tokens: scale("brand", [
      [50, "#f9ebe7"],
      [100, "#f0cec5"],
      [200, "#e3a798"],
      [300, "#d18270"],
      [400, "#c06a58"],
      [500, "#a65544"],
      [600, "#8b4537"],
      [700, "#6e372c"],
      [800, "#4d2720"],
      [900, "#2a1612"],
    ]),
  },
  {
    comment: ["Primary — teal. Active, link, current, primary action."],
    tokens: scale("primary", [
      [50, "#e6faf4"],
      [100, "#b3f0de"],
      [200, "#80e6c8"],
      [300, "#4ddcb2"],
      [400, "#2dd4a8"],
      [500, "#1aae8a"],
      [600, "#14896c"],
      [700, "#0e644e"],
      [800, "#083f30"],
      [900, "#041f18"],
    ]),
  },
  {
    comment: ["Neutral — warm gray, NOT blue-gray"],
    tokens: scale("neutral", [
      [0, "#ffffff"],
      [50, "#f8f8f6"],
      [100, "#f0efed"],
      [150, "#e6e5e2"],
      [200, "#d5d4d0"],
      [300, "#b5b4af"],
      [400, "#908f8a"],
      [500, "#6e6d69"],
      [600, "#53524f"],
      [700, "#3a3a37"],
      [800, "#272724"],
      [850, "#1e1e1b"],
      [900, "#161613"],
      [950, "#0f0f0d"],
    ]),
  },
  {
    comment: ["Warning — amber, for soft attention (due-soon, notice)."],
    tokens: scale("warning", [
      [400, "#e8a44c"],
      [500, "#c78f3a"],
      [600, "#8f6526"],
    ]),
  },
  {
    comment: ["Danger — red, for destructive / overdue."],
    tokens: scale("danger", [
      [400, "#f87171"],
      [500, "#ef4444"],
      [600, "#dc2626"],
    ]),
  },
  {
    comment: [
      "Status colors (match Tailwind defaults — intentional).",
      "Used as user-assignable category colors, NOT semantic status.",
    ],
    tokens: [
      ...scale("red", [
        [400, "#f87171"],
        [500, "#ef4444"],
        [600, "#dc2626"],
      ]),
      ...scale("yellow", [
        [400, "#fbbf24"],
        [500, "#f59e0b"],
      ]),
      ...scale("blue", [
        [400, "#60a5fa"],
        [500, "#3b82f6"],
      ]),
      ...scale("green", [
        [400, "#34d399"],
        [500, "#10b981"],
      ]),
      ...scale("purple", [
        [400, "#a78bfa"],
        [500, "#8b5cf6"],
      ]),
      ...scale("pink", [
        [400, "#f472b6"],
        [500, "#ec4899"],
      ]),
    ],
  },
  {
    comment: ["Folder / category palette (fixed set, user-assignable)"],
    tokens: scale("folder", [
      ["red", "#d9577a"],
      ["orange", "#e09b4a"],
      ["yellow", "#c4a143"],
      ["green", "#57a872"],
      ["teal", "#3dbda7"],
      ["blue", "#539bf5"],
      ["purple", "#9b8ae8"],
      ["pink", "#db6c9e"],
    ]),
  },
  {
    comment: ["Typography"],
    tokens: [
      {
        name: "font-sans",
        value: fontStack(["-apple-system", "SF Pro Text", "system-ui", "sans-serif"]),
      },
      {
        name: "font-display",
        value: fontStack(["-apple-system", "SF Pro Display", "system-ui", "sans-serif"]),
      },
      { name: "font-mono", value: fontStack(["SF Mono", "ui-monospace", "monospace"]) },
    ],
  },
  {
    comment: ["Border Radius"],
    tokens: [
      { name: "radius", value: px(6) },
      { name: "radius-sm", value: px(4) },
      { name: "radius-md", value: px(6) },
      { name: "radius-lg", value: px(8) },
      { name: "radius-xl", value: px(12) },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 2 — semantic tokens
// ═══════════════════════════════════════════════════════════════════════════════

const SELECTION_TINT = hex("#2dd4a8");

export const SEMANTIC_GROUPS: readonly TokenGroup[] = [
  {
    comment: ["Identity"],
    tokens: [
      {
        dark: ref("color-brand-400"),
        doc: "Terracotta. Identity-only — never on interactive UI.",
        name: "brand-identity",
        value: ref("color-brand-500"),
      },
    ],
  },
  {
    comment: ["Surfaces"],
    tokens: [
      { dark: hex("#161613"), name: "surface-primary", value: hex("#ffffff") },
      { dark: hex("#141412"), name: "surface-secondary", value: hex("#fbfbf9") },
      { dark: hex("#121210"), name: "surface-tertiary", value: hex("#f6f6f4") },
      { dark: hex("#1c1c19"), name: "surface-elevated", value: hex("#ffffff") },
      { dark: hex("#0f0f0d"), name: "surface-inset", value: hex("#eae9e6") },
      { dark: hex("#272724"), name: "surface-hover", value: hex("#f0efed") },
      { dark: hex("#3a3a37"), name: "surface-active", value: hex("#e6e5e2") },
      {
        dark: mix("srgb", SELECTION_TINT, 12, transparent),
        name: "surface-selected",
        value: mix("srgb", SELECTION_TINT, 10, transparent),
      },
      { dark: hex("#2f2f2c"), name: "surface-nav-selected", value: hex("#ebeae7") },
    ],
  },
  {
    comment: ["Text"],
    tokens: [
      { dark: hex("#f0efed"), name: "text-primary", value: hex("#161613") },
      { dark: hex("#b0afaa"), name: "text-secondary", value: hex("#5a5955") },
      // The faintest text a reader has to read: 5:1 on white and on the dark popover. An opacity
      // step on any text token drops below 4.5:1 by /75, so faded text is for separators and icons.
      { dark: hex("#999893"), name: "text-tertiary", value: hex("#6f6e6a") },
      // 3.3:1 on white: disabled controls and display-size type only, never body-size text.
      { dark: hex("#8e8d88"), name: "text-disabled", value: hex("#8e8d88") },
      { dark: hex("#161613"), name: "text-inverse", value: hex("#ffffff") },
      { dark: hex("#2dd4a8"), name: "text-brand", value: hex("#14896c") },
      { dark: hex("#2dd4a8"), name: "text-link", value: hex("#1aae8a") },
      // text-link's light value is 2.8:1 on white; teal a reader has to read as text needs 4.5:1.
      { dark: hex("#2dd4a8"), name: "text-action", value: hex("#117a60") },
      // status-due-soon is 2.9:1 as text. Its bright step stays for flags and checkbox strokes, where
      // darkening it would merge with overdue red for a red-green colour-blind reader.
      { dark: hex("#f59e42"), name: "text-due-soon", value: hex("#a0600a") },
    ],
  },
  {
    comment: ["Borders"],
    tokens: [
      { dark: hex("#3a3a37"), name: "border-primary", value: hex("#d5d4d0") },
      { dark: hex("#272724"), name: "border-secondary", value: hex("#e6e5e2") },
      { dark: hex("#1e1e1b"), name: "border-subtle", value: hex("#f0efed") },
      { dark: hex("#2dd4a8"), name: "border-focus", value: hex("#2dd4a8") },
      // An unchecked checkbox's stroke. border-primary is 1.6:1 on the dark ground and 1.3:1 on a
      // selected row; this is 3.3:1 on that row.
      { dark: hex("#7a7975"), name: "border-control", value: hex("#d5d4d0") },
    ],
  },
  {
    comment: ["Interactive"],
    tokens: [
      { dark: hex("#2dd4a8"), name: "interactive-primary", value: hex("#1aae8a") },
      { dark: hex("#4ddcb2"), name: "interactive-primary-hover", value: hex("#14896c") },
      // Solid fills behind a white label, 4.5:1 in both themes; interactive-primary is 2.8:1 in light and 1.9:1 in dark.
      { dark: hex("#117a60"), name: "interactive-fill", value: hex("#117a60") },
      { dark: hex("#6b6a66"), name: "interactive-fill-neutral", value: hex("#5a5955") },
      { dark: hex("#272724"), name: "interactive-secondary", value: hex("#f0efed") },
      { dark: hex("#3a3a37"), name: "interactive-secondary-hover", value: hex("#e6e5e2") },
    ],
  },
  {
    comment: ["Status"],
    tokens: [
      { dark: hex("#f87171"), name: "status-overdue", value: hex("#dc2626") },
      { dark: hex("#f59e42"), name: "status-due-soon", value: hex("#d4850f") },
      { dark: hex("#60a5fa"), name: "status-open", value: hex("#3b82f6") },
      { dark: hex("#34d399"), name: "status-done", value: hex("#10b981") },
    ],
  },
  {
    comment: ["Priority"],
    tokens: [
      // Urgent's own hue, so red means only late. At least 4.5:1 as text on every surface a row
      // sits on, the selected row included, so one value serves the mark and the checkbox.
      { dark: hex("#a78bfa"), name: "priority-urgent", value: hex("#7c3aed") },
    ],
  },
  {
    comment: ["Code (each at least 4.5:1 on surface-inset, a code block's fill)"],
    darkComment: ["Code"],
    tokens: [
      { dark: hex("#c4b5fd"), name: "code-keyword", value: hex("#6d28d9") },
      { dark: hex("#86efac"), name: "code-string", value: hex("#166534") },
      { dark: hex("#fdba74"), name: "code-number", value: hex("#9a3412") },
      { dark: hex("#93c5fd"), name: "code-title", value: hex("#1d4ed8") },
      { dark: hex("#5eead4"), name: "code-type", value: hex("#115e59") },
      { dark: ref("text-tertiary"), name: "code-comment", value: ref("text-secondary") },
      { dark: hex("#fca5a5"), name: "code-deletion", value: hex("#b91c1c") },
    ],
  },
  {
    comment: ["Shadows (theme-aware — used via var(), not Tailwind utilities)"],
    darkComment: ["Shadows"],
    tokens: [
      {
        dark: shadow(layer(0, 1, 2, 0, rgba(0, 0, 0, 0.2))),
        name: "shadow-app-sm",
        value: shadow(layer(0, 1, 2, 0, rgba(0, 0, 0, 0.04))),
      },
      {
        dark: shadow(layer(0, 2, 8, 0, rgba(0, 0, 0, 0.3)), layer(0, 1, 2, 0, rgba(0, 0, 0, 0.2))),
        name: "shadow-app-md",
        value: shadow(
          layer(0, 2, 8, 0, rgba(0, 0, 0, 0.08)),
          layer(0, 1, 2, 0, rgba(0, 0, 0, 0.04))
        ),
      },
      {
        dark: shadow(layer(0, 8, 24, 0, rgba(0, 0, 0, 0.4)), layer(0, 2, 8, 0, rgba(0, 0, 0, 0.2))),
        name: "shadow-app-lg",
        value: shadow(
          layer(0, 8, 24, 0, rgba(0, 0, 0, 0.12)),
          layer(0, 2, 8, 0, rgba(0, 0, 0, 0.06))
        ),
      },
      {
        dark: shadow(
          layer(0, 4, 16, 0, rgba(0, 0, 0, 0.4)),
          layer(0, 0, 0, 1, ref("border-primary"))
        ),
        name: "shadow-app-popover",
        value: shadow(
          layer(0, 4, 16, 0, rgba(0, 0, 0, 0.12)),
          layer(0, 0, 0, 1, ref("border-primary"))
        ),
      },
    ],
  },
  {
    comment: ["Transitions (used via var())"],
    tokens: [
      { name: "transition-fast", value: transition(120, "ease") },
      { name: "transition-normal", value: transition(200, "ease") },
      { name: "transition-slow", value: transition(300, "ease") },
    ],
  },
  {
    comment: ["Letter spacing"],
    tokens: [
      { name: "tracking-tight", value: em(-0.02) },
      { name: "tracking-normal", value: em(0) },
      { name: "tracking-wide", value: em(0.03) },
    ],
  },
  {
    comment: ["Type scale (CSS font shorthand — use via font: var(--text-*))"],
    tokens: [
      { name: "text-display", value: typeStyle(500, 24, 1.3, "display") },
      { name: "text-heading-lg", value: typeStyle(500, 18, 1.4, "sans") },
      { name: "text-heading-sm", value: typeStyle(500, 15, 1.4, "sans") },
      { name: "text-body", value: typeStyle(400, 14, 1.6, "sans") },
      { name: "text-body-sm", value: typeStyle(400, 13, 1.5, "sans") },
      { name: "text-ui", value: typeStyle(500, 13, 1.3, "sans") },
      { name: "text-ui-sm", value: typeStyle(500, 11, 1.3, "sans") },
      { name: "text-mono", value: typeStyle(400, 12, 1.5, "mono") },
    ],
  },
  {
    comment: ["shadcn/ui backward-compatible aliases"],
    tokens: [
      alias("background", "surface-primary"),
      alias("foreground", "text-primary"),
      alias("card", "surface-elevated"),
      alias("card-foreground", "text-primary"),
      alias("popover", "surface-elevated"),
      alias("popover-foreground", "text-primary"),
      alias("primary", "interactive-primary"),
      alias("primary-foreground", "text-inverse"),
      alias("secondary", "interactive-secondary"),
      alias("secondary-foreground", "text-primary"),
      alias("muted", "surface-inset"),
      alias("muted-foreground", "text-secondary"),
      alias("accent", "surface-hover"),
      alias("accent-foreground", "text-primary"),
      alias("destructive", "status-overdue"),
      alias("border", "border-primary"),
      alias("input", "border-primary"),
      alias("ring", "border-focus"),
    ],
  },
  // The chart / sidebar / titlebar runs continue the shadcn block in the light
  // scheme (no banner, no blank line) but are labelled separately in the dark
  // one, which overrides only the charts and the titlebar.
  {
    comment: null,
    darkComment: ["Chart colors"],
    tokens: [
      { dark: hex("#f87171"), name: "chart-1", value: hex("#e5534b") },
      { dark: hex("#2dd4a8"), name: "chart-2", value: hex("#1aae8a") },
      { dark: hex("#60a5fa"), name: "chart-3", value: hex("#539bf5") },
      { dark: hex("#f59e42"), name: "chart-4", value: hex("#d4850f") },
      { dark: hex("#a78bfa"), name: "chart-5", value: hex("#9b8ae8") },
    ],
  },
  {
    comment: null,
    tokens: [
      alias("sidebar", "surface-tertiary"),
      alias("sidebar-foreground", "text-primary"),
      alias("sidebar-primary", "interactive-primary"),
      alias("sidebar-primary-foreground", "text-inverse"),
      alias("sidebar-accent", "surface-hover"),
      alias("sidebar-accent-foreground", "text-primary"),
      alias("sidebar-border", "border-secondary"),
      alias("sidebar-ring", "border-focus"),
    ],
  },
  {
    comment: null,
    darkComment: ["Titlebar"],
    tokens: [
      { dark: hex("#121210"), name: "titlebar", value: hex("#f6f6f4") },
      {
        dark: rgba(255, 255, 255, 0.07),
        name: "titlebar-border",
        value: rgba(0, 0, 0, 0.1),
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3 — Tailwind bridge (web only)
// ═══════════════════════════════════════════════════════════════════════════════

/** `--color-<name>: var(--<from>)`; `name` defaults to `from` for the common case. */
const bridge = (...names: readonly string[]) => names.map((from) => ({ from, name: from }));

export const TAILWIND_ALIAS_GROUPS: readonly TailwindAliasGroup[] = [
  {
    aliases: bridge(
      "surface-primary",
      "surface-secondary",
      "surface-tertiary",
      "surface-elevated",
      "surface-inset",
      "surface-hover",
      "surface-active",
      "surface-selected",
      "surface-nav-selected"
    ),
    comment: ["Semantic surface tokens"],
  },
  {
    aliases: bridge(
      "text-primary",
      "text-secondary",
      "text-tertiary",
      "text-disabled",
      "text-inverse",
      "text-brand",
      "text-link"
    ),
    comment: ["Semantic text tokens"],
  },
  {
    aliases: bridge(
      "border-primary",
      "border-secondary",
      "border-subtle",
      "border-focus",
      "border-control"
    ),
    comment: ["Semantic border tokens"],
  },
  {
    aliases: bridge(
      "interactive-primary",
      "interactive-primary-hover",
      "interactive-fill",
      "interactive-secondary",
      "interactive-secondary-hover"
    ),
    comment: ["Semantic interactive tokens"],
  },
  {
    aliases: bridge("status-overdue", "status-due-soon", "status-open", "status-done"),
    comment: ["Semantic status tokens"],
  },
  {
    aliases: bridge("priority-urgent"),
    comment: ["Semantic priority tokens"],
  },
  {
    aliases: [
      { from: "text-tertiary", name: "subtle" },
      { from: "text-disabled", name: "faint" },
      { from: "text-due-soon", name: "due-soon" },
      { from: "text-action", name: "action" },
    ],
    comment: ["Short aliases (avoid double text- prefix)"],
  },
  {
    aliases: bridge(
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "primary",
      "primary-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "accent-foreground",
      "destructive",
      "border",
      "input",
      "ring",
      "chart-1",
      "chart-2",
      "chart-3",
      "chart-4",
      "chart-5",
      "sidebar",
      "sidebar-foreground",
      "sidebar-primary",
      "sidebar-primary-foreground",
      "sidebar-accent",
      "sidebar-accent-foreground",
      "sidebar-border",
      "sidebar-ring",
      "titlebar",
      "titlebar-border"
    ),
    comment: ["shadcn/ui backward-compatible aliases"],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Lookups
// ═══════════════════════════════════════════════════════════════════════════════

function index(groups: readonly TokenGroup[]): ReadonlyMap<string, TokenDefinition> {
  return new Map(groups.flatMap((g) => g.tokens.map((t) => [t.name, t] as const)));
}

export const PRIMITIVES: ReadonlyMap<string, TokenDefinition> = index(PRIMITIVE_GROUPS);
export const SEMANTIC_TOKENS: ReadonlyMap<string, TokenDefinition> = index(SEMANTIC_GROUPS);

/** Every token in either tier, keyed by name. */
export const ALL_TOKENS: ReadonlyMap<string, TokenDefinition> = new Map([
  ...PRIMITIVES,
  ...SEMANTIC_TOKENS,
]);

/** The value a token takes in `scheme`, falling back to the light value when unthemed. */
export function tokenValue(name: string, scheme: ColorScheme): TokenValue {
  const token = ALL_TOKENS.get(name);
  if (!token) throw new Error(`Unknown design token: ${name}`);
  return scheme === "dark" ? (token.dark ?? token.value) : token.value;
}

/**
 * The literal `#rrggbb` a token resolves to, following refs. Throws for tokens
 * whose value is not a flat color (a mix, a shadow, a type step) — callers that
 * need one of those want the value node, not a hex.
 */
export function tokenHex(name: string, scheme: ColorScheme): string {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) throw new Error(`Cyclic design token reference at: ${current}`);
    seen.add(current);
    const value = tokenValue(current, scheme);
    if (value.kind === "hex") return value.hex;
    if (value.kind !== "ref") {
      throw new Error(`Design token ${name} does not resolve to a hex color (${value.kind})`);
    }
    current = value.token;
  }
}
