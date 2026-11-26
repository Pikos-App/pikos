// Always nests the full provider tree in the canonical order, so a new provider is added in one
// place. Tests that render WITHOUT a provider (to assert the hook throws) keep their own setup.

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
import { InterfaceSettingsProvider } from "@/shared/context/InterfaceSettingsContext";
import { PagesProvider } from "@/shared/context/PagesContext";
import { RecurringGapDialogProvider } from "@/shared/context/RecurringGapDialogContext";
import { SelectionProvider } from "@/shared/context/SelectionContext";
import { UIProvider } from "@/shared/context/UIContext";
import { UndoDeleteProvider } from "@/shared/context/UndoDeleteContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";

// WorkspaceProvider constructs the in-memory adapter synchronously during render, so it is
// registered here before the first provider mounts, not in the global setup: specs that never
// touch it shouldn't pay to load a 1,400-line adapter.
setMockStorageFactory(() => new MockStorageAdapter());

// Settings sit outermost, as they do in App.tsx: they are plain preferences with no workspace
// behind them, and PagesProvider reads the default folder to decide where a restored page lands
// when its own folder has gone. Nested inside, that read would throw.
function TestProviders({ children }: { children: ReactNode }) {
  return (
    <AppSettingsProvider>
      <WorkspaceProvider>
        <PagesProvider>
          <ImportProvider>
            <UIProvider>
              <SelectionProvider>
                <CalendarDnDProvider>
                  <UndoDeleteProvider>
                    <RecurringGapDialogProvider>
                      <InterfaceSettingsProvider>{children}</InterfaceSettingsProvider>
                    </RecurringGapDialogProvider>
                  </UndoDeleteProvider>
                </CalendarDnDProvider>
              </SelectionProvider>
            </UIProvider>
          </ImportProvider>
        </PagesProvider>
      </WorkspaceProvider>
    </AppSettingsProvider>
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
