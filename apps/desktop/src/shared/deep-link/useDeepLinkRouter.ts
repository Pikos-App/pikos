import { listen } from "@tauri-apps/api/event";
import { getHours, getMinutes } from "date-fns";
import { useEffect, useRef } from "react";

import { useCalendarDate } from "@/shared/context/CalendarDateContext";
import { useUI } from "@/shared/context/UIContext";
import { createLogger } from "@/shared/logger";
import { getPlatform } from "@/shared/platform";

import { type DeepLinkAction, parseDeepLink } from "./parseDeepLink";

const log = createLogger("deep-link");

const DEEP_LINK_EVENT = "pikos://open-url";

export function useDeepLinkRouter() {
  const ui: Targets = { ...useUI(), ...useCalendarDate() };

  // A ref, so the listener subscription stays mounted instead of being torn down each render.
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
        if (cancelled) {
          un();
          return;
        }
        unlisten = un;
        // After the subscription, never before: a held click emits immediately.
        void getPlatform()
          .replayPendingNotificationClicks()
          .catch((err: unknown) => {
            log.error("failed to replay pending notification clicks", err);
          });
      })
      .catch((err: unknown) => {
        log.error("failed to subscribe to deep-link events", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

type Targets = ReturnType<typeof useUI> & ReturnType<typeof useCalendarDate>;

function dispatch(ui: Targets, action: DeepLinkAction) {
  switch (action.type) {
    case "page":
      ui.openPage(action.pageId);
      return;
    case "view":
      ui.setActiveViewId(action.viewId);
      return;
    case "calendar": {
      // Notification click: reveal the calendar at the current time. Close Settings first (a reminder
      // can fire while it is open) and scroll an hour above "now" so the now-line has context above it.
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
