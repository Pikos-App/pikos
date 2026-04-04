// SettingsPage — full-screen overlay with sidebar nav + content area.
// Triggered by the gear icon at the bottom of the main sidebar.

import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { CSVColumnMappingPage, ImportPreviewModal, useImport } from "@/features/import";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useIsFullscreen } from "@/shared/hooks/useIsFullscreen";

import { AppearanceSettings } from "./AppearanceSettings";
import { EditorSettings } from "./EditorSettings";
import { GeneralSettings } from "./GeneralSettings";
import { NotificationSettings } from "./NotificationSettings";
import { SettingsNav, type SettingsSection } from "./SettingsNav";
import { ShortcutsSettings } from "./ShortcutsSettings";

const DeveloperSettings = import.meta.env.DEV
  ? lazy(() => import("./DeveloperSettings").then((m) => ({ default: m.DeveloperSettings })))
  : null;

function readLeftPanelWidth(): number {
  try {
    const raw = localStorage.getItem("pikos:leftPanelWidth");
    return raw ? (JSON.parse(raw) as number) : 180;
  } catch {
    return 180;
  }
}

export function SettingsPage() {
  const { setActiveViewId, setSettingsOpen, settingsOpen } = useUI();
  const { clearLastImport, lastImportResult, undoLastImport } = useWorkspace();
  const isFullscreen = useIsFullscreen();
  const [sidebarWidth] = useState(readLeftPanelWidth);
  const [section, setSection] = useState<SettingsSection>("general");
  const {
    applyCSVMapping,
    executeImport,
    parseCSVFile,
    parseMarkdownDir,
    reset,
    state: importState,
  } = useImport();

  // Auto-close settings when import completes — the "done" state is stored in
  // WorkspaceContext (lastImportResult) which survives the component remount.
  const prevStepRef = useRef(importState.step);
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = importState.step;
    if (prev === "importing" && importState.step === "done") {
      reset();
      setActiveViewId("inbox");
      setSettingsOpen(false);
    }
  }, [importState.step, reset, setActiveViewId, setSettingsOpen]);

  // Close on Escape — go back from mapping/preview first, then close settings
  useEffect(() => {
    if (!settingsOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (importState.step === "mapping" || importState.step === "preview") {
          reset();
        } else {
          setSettingsOpen(false);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, setSettingsOpen, importState.step, reset]);

  if (!settingsOpen) return null;

  const showingMapping = importState.step === "mapping";
  const showingPreview = importState.step === "preview";
  const showingProgress = importState.step === "importing";

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex bg-background text-foreground"
      style={{ top: isFullscreen ? 0 : 30 }}
    >
      <SettingsNav
        active={section}
        onClose={() => setSettingsOpen(false)}
        onNavigate={setSection}
        width={sidebarWidth}
      />

      {/* Content — mapping → preview → progress, or normal section */}
      {showingMapping ? (
        <CSVColumnMappingPage
          headers={importState.headers}
          initialConfig={importState.initialConfig}
          onCancel={reset}
          onConfirm={applyCSVMapping}
          rows={importState.rows}
        />
      ) : showingPreview ? (
        <ImportPreviewModal
          onCancel={reset}
          onConfirm={(skipCompleted) => {
            const plan = skipCompleted
              ? {
                  ...importState.plan,
                  pages: importState.plan.pages.filter((p) => p.status !== "done"),
                }
              : importState.plan;
            void executeImport(plan);
          }}
          plan={importState.plan}
        />
      ) : showingProgress ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Importing...</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-8">
          {section === "general" && (
            <GeneralSettings
              importState={importState}
              lastImportResult={lastImportResult}
              onClearImport={clearLastImport}
              onUndoImport={undoLastImport}
              parseCSVFile={parseCSVFile}
              parseMarkdownDir={parseMarkdownDir}
              resetImport={reset}
            />
          )}
          {section === "appearance" && <AppearanceSettings />}
          {section === "editor" && <EditorSettings />}
          {section === "notifications" && <NotificationSettings />}
          {section === "shortcuts" && <ShortcutsSettings />}
          {section === "developer" && DeveloperSettings && (
            <Suspense>
              <DeveloperSettings />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}
