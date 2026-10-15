// What the middle column is currently showing, resolved once by whoever owns the
// column rather than by whichever panel happens to be rendering it.
//
// The trash is its own panel, so opening it unmounts the page list — and with it
// anything the page list had registered. That is fine for the list's own
// behaviour, and wrong for the delete shortcut, which acts on the active page and
// should not stop working because a different view took the column. Reading the
// data here lets the shortcut live above the branch without a second copy of the
// queries behind it.

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
