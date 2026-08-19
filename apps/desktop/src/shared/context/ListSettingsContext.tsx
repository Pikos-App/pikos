import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type ListDensity = "compact" | "cozy" | "spacious";

export interface ListSettingsValue {
  density: ListDensity;
  setDensity: (v: ListDensity) => void;
}

function useListSettingsValue(): ListSettingsValue {
  const [density, setDensity] = useLocalStorage<ListDensity>("pikos:listDensity", "cozy");

  return { density, setDensity };
}

const listSettings = createSettingsContext("ListSettings", useListSettingsValue);

export const ListSettingsProvider = listSettings.Provider;
export const useListSettings = listSettings.useSettings;
