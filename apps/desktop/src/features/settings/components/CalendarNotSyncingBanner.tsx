import type { AccountNotSyncing } from "@pikos/core";
import { accountAddress, accountsNotSyncing } from "@pikos/core";
import { formatDistance } from "date-fns";
import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useNow } from "@/shared/hooks/useNow";

import { useCalendarSync } from "../hooks/useCalendarSync";
import { ReconnectAccountDialog } from "./ReconnectAccountDialog";

/** Over the editor and the calendar alike, since Settings was the only place that said a
 *  calendar had stopped syncing. Hiding it lasts until the app next opens. */
export function CalendarNotSyncingBanner() {
  const { accounts, busyAccountId, lastPassAt, reconnect, reconnectGoogle, resync } =
    useCalendarSync();
  const now = useNow();
  const [hidden, setHidden] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);

  const found = hidden ? [] : accountsNotSyncing(accounts, lastPassAt, now);
  const reconnecting = accounts.find((a) => a.id === reconnectingId);

  return (
    <>
      {found.length > 0 && (
        <div
          aria-label="Calendar not syncing"
          className="flex items-start gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-amber-600/90 dark:text-amber-400/90"
          role="region"
        >
          <ul className="flex min-w-0 flex-1 flex-col gap-1">
            {found.map((f) => (
              <li className="flex items-center gap-2" key={f.account.id}>
                <TriangleAlert aria-hidden="true" className="shrink-0" size={14} />
                <p className="type-ui-sm min-w-0 flex-1">{message(f, now)}</p>
                {f.reason === "reconnectNeeded" ? (
                  <Button
                    onClick={() => setReconnectingId(f.account.id)}
                    size="xs"
                    variant="outline"
                  >
                    Reconnect
                  </Button>
                ) : (
                  <Button
                    disabled={busyAccountId === f.account.id}
                    onClick={() => void resync(f.account.id)}
                    size="xs"
                    variant="outline"
                  >
                    Try again
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <Button
            aria-label="Hide until Pikos opens again"
            onClick={() => setHidden(true)}
            size="icon-xs"
            variant="ghost"
          >
            <X />
          </Button>
        </div>
      )}
      {reconnecting && (
        <ReconnectAccountDialog
          account={reconnecting}
          onOpenChange={(open) => {
            if (!open) setReconnectingId(null);
          }}
          onReconnect={(password) => reconnect(reconnecting.id, password)}
          onReconnectGoogle={() => reconnectGoogle(reconnecting.id)}
          open
        />
      )}
    </>
  );
}

function message(f: AccountNotSyncing, now: Date): string {
  const name = accountAddress(f.account);
  const since = f.lastSyncedAt
    ? ` Last synced ${formatDistance(new Date(f.lastSyncedAt), now, { addSuffix: true })}.`
    : "";
  return f.reason === "reconnectNeeded"
    ? `${name} needs you to sign in again, so its events and reminders may be out of date.${since}`
    : `Pikos can't reach ${name}, so its events and reminders may be out of date.${since}`;
}
