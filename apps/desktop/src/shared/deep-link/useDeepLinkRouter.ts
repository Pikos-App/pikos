// Listens for pikos:// URLs emitted from the Rust deep-link handler and
// dispatches them through the UIContext. Mount once at the app shell.

import { listen } from "@tauri-apps/api/event";
import { getHours, getMinutes } from "date-fns";
import { useEffect, useRef } from "react";

import { useUI } from "@/shared/context/UIContext";
import { createLogger } from "@/shared/logger";

import { type DeepLinkAction, parseDeepLink } from "./parseDeepLink";

const log = createLogger("deep-link");

const DEEP_LINK_EVENT = "pikos://open-url";

export function useDeepLinkRouter() {
  const ui = useUI();

  // Latest ui is stashed in a ref so the listener subscription stays
  // mounted for the whole app lifetime instead of being torn down each render.
  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listen<string>(DEEP_LINK_EVENT, (event) => {
      const action = parseDeepLink(event.payload);
      if (!action) {
        log.warn("ignored unparseable deep link");
        return;
      }
      dispatch(uiRef.current, action);
    })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((err: unknown) => {
        log.error(
          "failed to subscribe to deep-link events",
          err instanceof Error ? err.name : "unknown"
        );
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

function dispatch(ui: ReturnType<typeof useUI>, action: DeepLinkAction) {
  switch (action.type) {
    case "page":
      ui.openPage(action.pageId);
      return;
    case "view":
      ui.setActiveViewId(action.viewId);
      return;
    case "calendar": {
      // Notification click: reveal the calendar at the current time. Close
      // Settings first so the panel is actually visible (a reminder can fire
      // while the user sits in Settings). Scroll an hour above "now" so the
      // now-line — and any block firing shortly after — has context above it.
      const now = new Date();
      ui.setSettingsOpen(false);
      ui.setReferenceDate(now);
      ui.requestCalendarScroll(Math.max(0, getHours(now) + getMinutes(now) / 60 - 1));
      ui.setRightPanel("calendar");
      return;
    }
    case "quick-add":
      ui.setOpenDialog("quick-add", action.prefill);
      return;
    case "search":
      ui.setOpenDialog("search", action.prefill);
      return;
  }
}
