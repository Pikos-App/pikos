// Settings contexts all have the same skeleton: a nullable context, a provider
// that publishes one value object, and a hook that refuses to run outside the
// provider. Only the value differs, so that is the only thing each settings
// module writes — it hands its value hook here and gets the skeleton back.

import { createContext, type ReactNode, useContext } from "react";

export interface SettingsContext<T> {
  /** Exposed for the rare caller that needs to override the value for a
   *  subtree (see WeekGrid's standalone calendar). */
  Context: React.Context<T | null>;
  Provider: (props: { children: ReactNode }) => ReactNode;
  useSettings: () => T;
}

/**
 * @param name Bare context name ("ListSettings") — spells the provider element
 *   and hook in the out-of-provider error, so it must match the exported names.
 * @param useValue Hook building the context value. Runs inside the provider.
 */
export function createSettingsContext<T>(name: string, useValue: () => T): SettingsContext<T> {
  const Context = createContext<T | null>(null);

  function Provider({ children }: { children: ReactNode }) {
    return <Context.Provider value={useValue()}>{children}</Context.Provider>;
  }
  Provider.displayName = `${name}Provider`;

  function useSettings(): T {
    const ctx = useContext(Context);
    if (!ctx) throw new Error(`use${name} must be used within <${name}Provider>`);
    return ctx;
  }

  return { Context, Provider, useSettings };
}
