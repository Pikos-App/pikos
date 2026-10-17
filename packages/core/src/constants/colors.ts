// Shared colour palette for folders AND external-calendar folders — both pick
// from the same set so a synced calendar never clashes with the user's own
// folder colours. Provider hex is deliberately not inherited — arbitrary
// provider colours fight this palette and dark mode.

export interface PaletteColor {
  label: string;
  value: string;
}

// Base saturated row, then a pastel row. Synced calendars tend toward the
// pastels so they read as ambient/background next to vivid native folders.
export const PALETTE_COLORS: readonly PaletteColor[] = [
  { label: "Red", value: "#D9577A" },
  { label: "Orange", value: "#E09B4A" },
  { label: "Yellow", value: "#C4A143" },
  { label: "Green", value: "#57A872" },
  { label: "Teal", value: "#3DBDA7" },
  { label: "Blue", value: "#539BF5" },
  { label: "Purple", value: "#9B8AE8" },
  { label: "Pink", value: "#DB6C9E" },
  { label: "Rose", value: "#E8A6A1" },
  { label: "Peach", value: "#E8C3A0" },
  { label: "Sand", value: "#DCCB97" },
  { label: "Sage", value: "#A8CDB4" },
  { label: "Mint", value: "#A6DBCF" },
  { label: "Sky", value: "#A6C8E8" },
  { label: "Lavender", value: "#C3B8E8" },
  { label: "Blush", value: "#E8B6CE" },
] as const;

// Palette values that have since moved, keyed by what a folder stored then. Red was #E5534B, close
// enough to the overdue red that a red folder's dot read as an alarm. Stored colours are mapped when
// read rather than rewritten, so an older workspace needs no migration and the picker still marks
// the swatch a folder was given.
const MOVED_PALETTE_COLORS: Record<string, string> = {
  "#E5534B": "#D9577A",
};

// The colour to draw for a stored folder or calendar colour.
export function currentPaletteColor(stored: string): string;
export function currentPaletteColor(stored: string | null | undefined): string | null | undefined;
export function currentPaletteColor(stored: string | null | undefined): string | null | undefined {
  if (!stored) return stored;
  return MOVED_PALETTE_COLORS[stored.toUpperCase()] ?? stored;
}

export function withCurrentColor<T extends { color?: string | null }>(item: T): T {
  const color = currentPaletteColor(item.color);
  return color === item.color ? item : { ...item, color };
}

// Default colour a calendar's folder takes on first enable, keyed by provider.
// The user can recolour from the full palette afterwards.
const EXTERNAL_CALENDAR_DEFAULT_COLOR: Record<string, string> = {
  caldav: "#A6C8E8", // Sky
  google: "#A8CDB4", // Sage
};

export function defaultColorForProvider(provider: string): string {
  return EXTERNAL_CALENDAR_DEFAULT_COLOR[provider] ?? "#A6C8E8";
}
