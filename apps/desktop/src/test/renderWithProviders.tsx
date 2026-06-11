// Shared test wrapper. Replaces the per-file `wrapper` boilerplate that
// re-stacked the provider tree in slightly different combinations.
//
// Always nests the full provider tree in the canonical order — extra
// providers in a test that doesn't use them are cheap, and a single source
// means a new provider needs adding in exactly one place.
//
// Tests that intentionally render WITHOUT a provider (to assert the hook
// throws "must be used within …") should keep their bespoke setup — the
// failure-mode test is the one place where omitting a provider is the point.

import { renderHook, type RenderHookOptions } from "@testing-library/react";
import type { ReactNode } from "react";

import { CalendarDnDProvider } from "@/shared/context/CalendarDnDContext";
import { ImportProvider } from "@/shared/context/ImportContext";
import { PagesProvider } from "@/shared/context/PagesContext";
import { RecurringCompleteDialogProvider } from "@/shared/context/RecurringCompleteDialogContext";
import { SelectionProvider } from "@/shared/context/SelectionContext";
import { UIProvider } from "@/shared/context/UIContext";
import { UndoDeleteProvider } from "@/shared/context/UndoDeleteContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <PagesProvider>
        <ImportProvider>
          <UIProvider>
            <SelectionProvider>
              <CalendarDnDProvider>
                <UndoDeleteProvider>
                  <RecurringCompleteDialogProvider>{children}</RecurringCompleteDialogProvider>
                </UndoDeleteProvider>
              </CalendarDnDProvider>
            </SelectionProvider>
          </UIProvider>
        </ImportProvider>
      </PagesProvider>
    </WorkspaceProvider>
  );
}

export function renderHookWithProviders<Result, Props>(
  callback: (props: Props) => Result,
  options?: Omit<RenderHookOptions<Props>, "wrapper">
) {
  return renderHook(callback, { ...options, wrapper: TestProviders });
}
