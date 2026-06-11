import { createContext, type ReactNode, useContext } from "react";

import { type AutoUpdater, useAutoUpdater } from "@/shared/hooks/useAutoUpdater";

const UpdateContext = createContext<AutoUpdater | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const updater = useAutoUpdater();
  return <UpdateContext.Provider value={updater}>{children}</UpdateContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUpdate(): AutoUpdater {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within <UpdateProvider>");
  return ctx;
}
