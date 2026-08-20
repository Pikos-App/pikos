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

import { MockStorageAdapter } from "@pikos/core/testing";
import {
  render,
  renderHook,
  type RenderHookOptions,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { setMockStorageFactory } from "@/shared/adapters/mockStorageChunk";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { CalendarDnDProvider } from "@/shared/context/CalendarDnDContext";
import { ImportProvider } from "@/shared/context/ImportContext";
import { ListSettingsProvider } from "@/shared/context/ListSettingsContext";
import { PagesProvider } from "@/shared/context/PagesContext";
import { RecurringGapDialogProvider } from "@/shared/context/RecurringGapDialogContext";
import { SelectionProvider } from "@/shared/context/SelectionContext";
import { UIProvider } from "@/shared/context/UIContext";
import { UndoDeleteProvider } from "@/shared/context/UndoDeleteContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";

// Production keeps the in-memory adapter behind an import() so it never ships
// (see shared/adapters/inMemoryStorage.ts), and WorkspaceProvider constructs it
// synchronously during render — so it has to be registered before the first
// one mounts. Registered here rather than in the global test setup: this module
// is what every test rendering that provider goes through, and the ~30 specs
// that never touch it should not pay to load a 1,400-line adapter.
setMockStorageFactory(() => new MockStorageAdapter());

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <PagesProvider>
        <ImportProvider>
          <UIProvider>
            <SelectionProvider>
              <CalendarDnDProvider>
                <UndoDeleteProvider>
                  <RecurringGapDialogProvider>
                    <ListSettingsProvider>
                      <AppSettingsProvider>{children}</AppSettingsProvider>
                    </ListSettingsProvider>
                  </RecurringGapDialogProvider>
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

export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { ...options, wrapper: TestProviders });
}
