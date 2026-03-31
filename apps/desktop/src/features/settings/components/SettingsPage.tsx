// SettingsPage — full-screen overlay with sidebar nav + content area.
// Triggered by the gear icon at the bottom of the main sidebar.

import { lazy, Suspense, useEffect, useState } from "react";

import { useUI } from "@/shared/context/UIContext";
import { useIsFullscreen } from "@/shared/hooks/useIsFullscreen";

import { AppearanceSettings } from "./AppearanceSettings";
import { GeneralSettings } from "./GeneralSettings";
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
  const { setSettingsOpen, settingsOpen } = useUI();
  const isFullscreen = useIsFullscreen();
  const [sidebarWidth] = useState(readLeftPanelWidth);
  const [section, setSection] = useState<SettingsSection>("general");

  // Close on Escape
  useEffect(() => {
    if (!settingsOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSettingsOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, setSettingsOpen]);

  if (!settingsOpen) return null;

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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        {section === "general" && <GeneralSettings />}
        {section === "appearance" && <AppearanceSettings />}
        {section === "shortcuts" && <ShortcutsSettings />}
        {section === "developer" && DeveloperSettings && (
          <Suspense>
            <DeveloperSettings />
          </Suspense>
        )}
      </div>
    </div>
  );
}
