import { createContext, type ReactNode, useContext } from "react";

import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type ListDensity = "compact" | "cozy" | "spacious";

export interface ListSettingsValue {
  density: ListDensity;
  setDensity: (v: ListDensity) => void;
}

const ListSettingsContext = createContext<ListSettingsValue | null>(null);

export function ListSettingsProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useLocalStorage<ListDensity>("pikos:listDensity", "cozy");

  const value: ListSettingsValue = { density, setDensity };

  return <ListSettingsContext.Provider value={value}>{children}</ListSettingsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useListSettings(): ListSettingsValue {
  const ctx = useContext(ListSettingsContext);
  if (!ctx) throw new Error("useListSettings must be used within <ListSettingsProvider>");
  return ctx;
}
