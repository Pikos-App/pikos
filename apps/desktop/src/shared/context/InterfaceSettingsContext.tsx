import { STORAGE_KEYS } from "@/shared/constants/storage";
import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type ListDensity = "compact" | "cozy" | "spacious";

/** Multipliers on the whole interface type scale, ascending. Not px, because
 *  this scales a scale: the sidebar, lists, dialogs and menus each keep their
 *  own relative sizes and move together. The top is 2× so text that starts at
 *  the app's 11px floor can reach the 22px the accessibility guidance asks for
 *  (PKOS-0067). */
export const INTERFACE_TEXT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;

export type InterfaceTextScale = (typeof INTERFACE_TEXT_SCALES)[number];

export const DEFAULT_INTERFACE_TEXT_SCALE: InterfaceTextScale = 1;

/** The next rung above (`1`) or below (`-1`), or the same value at either end.
 *  Matches on the value rather than an index so a scale persisted by an older
 *  ladder still steps instead of stranding the keys. */
export function stepInterfaceTextScale(
  scale: InterfaceTextScale,
  direction: 1 | -1
): InterfaceTextScale {
  if (direction === 1) return INTERFACE_TEXT_SCALES.find((s) => s > scale) ?? scale;
  const smaller = INTERFACE_TEXT_SCALES.filter((s) => s < scale);
  return smaller[smaller.length - 1] ?? scale;
}

export interface InterfaceSettingsValue {
  density: ListDensity;
  setDensity: (v: ListDensity) => void;
  /** Multiplier on `--ui-text-scale`, which the whole `--text-*` scale rides. */
  textScale: InterfaceTextScale;
  setTextScale: (v: InterfaceTextScale) => void;
  stepTextScale: (direction: 1 | -1) => void;
}

function useInterfaceSettingsValue(): InterfaceSettingsValue {
  const [density, setDensity] = useLocalStorage<ListDensity>(STORAGE_KEYS.listDensity, "cozy");
  const [textScale, setTextScale] = useLocalStorage<InterfaceTextScale>(
    STORAGE_KEYS.interfaceTextScale,
    DEFAULT_INTERFACE_TEXT_SCALE
  );

  return {
    density,
    setDensity,
    setTextScale,
    stepTextScale: (direction) => setTextScale((prev) => stepInterfaceTextScale(prev, direction)),
    textScale,
  };
}

const interfaceSettings = createSettingsContext("InterfaceSettings", useInterfaceSettingsValue);

export const InterfaceSettingsProvider = interfaceSettings.Provider;
export const useInterfaceSettings = interfaceSettings.useSettings;
