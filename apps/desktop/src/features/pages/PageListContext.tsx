// What the middle column shows, resolved once by whoever owns the column. The trash is its own panel,
// so opening it unmounts the page list and anything registered there; the delete shortcut acts on the
// active page and must not stop working then. Reading the data here lets it live above the branch
// without a second copy of the queries.

import { createContext, type ReactNode, useContext } from "react";

import { usePageList } from "./hooks/usePageList";

type PageListValue = ReturnType<typeof usePageList>;

const PageListContext = createContext<PageListValue | null>(null);

export function PageListProvider({ children }: { children: ReactNode }) {
  return <PageListContext.Provider value={usePageList()}>{children}</PageListContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePageListContext(): PageListValue {
  const ctx = useContext(PageListContext);
  if (!ctx) throw new Error("usePageListContext must be used within <PageListProvider>");
  return ctx;
}
