// Always false in test mode / non-Tauri environments.

import { useEffect, useState } from "react";

import { IS_TAURI } from "@/shared/constants/platform";

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
