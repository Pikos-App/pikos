import { Minus, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { IS_MACOS, IS_TAURI } from "@/shared/constants/platform";

const BAR_H = "h-[30px]";

export function TitleBar() {
  const initialized = useRef(false);

  // On Windows/Linux, remove native decorations at startup.
  // macOS uses titleBarStyle "Overlay" from tauri.conf.json instead.
  useEffect(() => {
    if (initialized.current || !IS_TAURI || IS_MACOS) return;
    initialized.current = true;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow().setDecorations(false);
    });
  }, []);

  const windowAction = (action: "minimize" | "toggleMaximize" | "close") => {
    if (!IS_TAURI) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow()[action]();
    });
  };

  return (
    <div
      className={`flex ${BAR_H} shrink-0 items-center border-b border-titlebar-border bg-titlebar`}
      data-tauri-drag-region
    >
      {/* macOS: reserve space for native traffic lights */}
      {IS_MACOS && <div className="w-[70px] shrink-0" data-tauri-drag-region />}

      <div className="flex-1" data-tauri-drag-region />

      {!IS_MACOS && IS_TAURI && (
        <div className="flex items-center">
          <button
            aria-label="Minimize"
            className={`flex ${BAR_H} w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent`}
            onClick={() => windowAction("minimize")}
          >
            <Minus size={14} />
          </button>
          <button
            aria-label="Maximize"
            className={`flex ${BAR_H} w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent`}
            onClick={() => windowAction("toggleMaximize")}
          >
            <Square size={11} />
          </button>
          <button
            aria-label="Close"
            className={`flex ${BAR_H} w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-[#e81123] hover:text-white`}
            onClick={() => windowAction("close")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
