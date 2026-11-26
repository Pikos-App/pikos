// One palette for folders and external-calendar folders, so a synced calendar never clashes with
// the user's own. Provider hex is not inherited: arbitrary provider colours fight this palette
// and dark mode.

export interface PaletteColor {
  label: string;
  value: string;
}

// A saturated row, then a pastel row; synced calendars take the pastels so they read as
// background next to vivid native folders.
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

// Palette values that moved, keyed by what a folder stored. The old red (#E5534B) was close enough
// to the overdue red that a red folder's dot read as an alarm. Stored colours are mapped on read,
// not rewritten, so an older workspace needs no migration and the picker still marks the swatch a
// folder was given.
const MOVED_PALETTE_COLORS: Record<string, string> = {
  "#E5534B": "#D9577A",
};

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

// The colour a calendar's folder takes on first enable, by provider.
const EXTERNAL_CALENDAR_DEFAULT_COLOR: Record<string, string> = {
  caldav: "#A6C8E8", // Sky
  google: "#A8CDB4", // Sage
};

export function defaultColorForProvider(provider: string): string {
  return EXTERNAL_CALENDAR_DEFAULT_COLOR[provider] ?? "#A6C8E8";
}
