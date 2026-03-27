// useIsFullscreen — tracks whether the window is in macOS native fullscreen.
// Returns false in test mode or on non-Tauri environments.

import { useEffect, useState } from "react";

const IS_TAURI = import.meta.env["VITE_TEST_MODE"] !== "true";

export function useIsFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;

    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win.isFullscreen().then(setFullscreen);
      void win
        .onResized(() => {
          void win.isFullscreen().then(setFullscreen);
        })
        .then((fn) => {
          unlisten = fn;
        });
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return fullscreen;
}
