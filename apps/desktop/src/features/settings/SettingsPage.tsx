// SettingsPage — full-screen overlay with sidebar nav + content area.
// Triggered by the gear icon at the bottom of the main sidebar.

import { useState, useEffect } from "react";
import { useUI } from "@/shared/context/UIContext";
import { SettingsNav, type SettingsSection } from "./SettingsNav";
import { AppearanceSettings } from "./pages/AppearanceSettings";
import { DeveloperSettings } from "./pages/DeveloperSettings";
import { GeneralSettings } from "./pages/GeneralSettings";
import { ShortcutsSettings } from "./pages/ShortcutsSettings";

function readLeftPanelWidth(): number {
  try {
    const raw = localStorage.getItem("pikos:leftPanelWidth");
    return raw ? (JSON.parse(raw) as number) : 180;
  } catch {
    return 180;
  }
}

export function SettingsPage() {
  const { settingsOpen, setSettingsOpen } = useUI();
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
    <div className="fixed inset-0 z-50 flex bg-background text-foreground">
      <SettingsNav
        active={section}
        onNavigate={setSection}
        onClose={() => setSettingsOpen(false)}
        width={sidebarWidth}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        {section === "general" && <GeneralSettings />}
        {section === "appearance" && <AppearanceSettings />}
        {section === "shortcuts" && <ShortcutsSettings />}
        {section === "developer" && <DeveloperSettings />}
      </div>
    </div>
  );
}
