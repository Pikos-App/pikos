import type { AccountWithCalendars, CalendarSyncResult } from "@pikos/core";
import { KeyRound, MoreHorizontal, RefreshCw, Server } from "lucide-react";
import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { defaultColorForProvider } from "@/shared/constants/colors";

import { ReconnectAccountDialog } from "./ReconnectAccountDialog";
import { SyncCalendarRow } from "./SyncCalendarRow";
import { accountConnectionState } from "./syncStatus";

interface SyncAccountCardProps {
  account: AccountWithCalendars;
  results: Record<string, CalendarSyncResult["status"]>;
  busy: boolean;
  onResync: () => void;
  onDisconnect: () => Promise<void>;
  onReconnect: (password: string) => Promise<void>;
  onReconnectGoogle: () => Promise<void>;
  onToggleCalendar: (calendarId: string, enabled: boolean, color: string | null) => void;
  onRecolorCalendar: (calendarId: string, color: string) => void;
}

export function SyncAccountCard({
  account,
  busy,
  onDisconnect,
  onRecolorCalendar,
  onReconnect,
  onReconnectGoogle,
  onResync,
  onToggleCalendar,
  results,
}: SyncAccountCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const connection = accountConnectionState(
    account.calendars.map((c) => results[c.id]),
    account.reconnectNeeded
  );

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{account.displayName}</p>
          {busy ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" />
              Syncing…
            </p>
          ) : connection === "reconnectNeeded" ? (
            <p className="text-xs text-destructive">
              Reconnect needed ·{" "}
              <button
                className="underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setReconnectOpen(true)}
              >
                Reconnect
              </button>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Connected</p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Account actions for ${account.displayName}`}
            className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={busy} onSelect={onResync}>
              <RefreshCw className="size-3.5" />
              Resync now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setReconnectOpen(true)}>
              <KeyRound className="size-3.5" />
              Reconnect…
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => setConfirmOpen(true)}
            >
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="px-4 py-1">
        {account.calendars.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No calendars discovered.</p>
        ) : (
          account.calendars.map((cal) => (
            <SyncCalendarRow
              calendar={cal}
              key={cal.id}
              lastResult={results[cal.id]}
              onRecolor={(color) => onRecolorCalendar(cal.id, color)}
              onToggle={(enabled) =>
                onToggleCalendar(
                  cal.id,
                  enabled,
                  enabled ? (cal.color ?? defaultColorForProvider(account.provider)) : cal.color
                )
              }
            />
          ))
        )}
      </div>

      <ReconnectAccountDialog
        account={account}
        onOpenChange={setReconnectOpen}
        onReconnect={onReconnect}
        onReconnectGoogle={onReconnectGoogle}
        open={reconnectOpen}
      />

      <ConfirmDialog
        busy={disconnecting}
        confirmLabel="Disconnect"
        description="Synced calendars will stop updating. Events you've edited or completed are kept; untouched mirror events are removed."
        onConfirm={() => {
          setDisconnecting(true);
          void onDisconnect()
            .then(() => setConfirmOpen(false))
            .finally(() => setDisconnecting(false));
        }}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        title={`Disconnect ${account.displayName}?`}
        variant="destructive"
      />
    </div>
  );
}
