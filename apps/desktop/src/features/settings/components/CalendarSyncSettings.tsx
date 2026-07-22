import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { useCalendarSync } from "../hooks/useCalendarSync";
import { AddAccountDialog } from "./AddAccountDialog";
import { SettingsSection } from "./SettingsSection";
import { SyncAccountCard } from "./SyncAccountCard";

export function CalendarSyncSettings() {
  const {
    accounts,
    busyAccountId,
    connect,
    connectGoogle,
    disconnect,
    error,
    googleAvailable,
    loading,
    recolorCalendar,
    results,
    resync,
    toggleCalendar,
  } = useCalendarSync();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="max-w-lg">
      <SettingsSection
        description="See your real calendar inside Pikos. Pikos only reads your events in. Your notes and pages never leave your device."
        title="Calendar Sync"
      >
        <div className="flex flex-col gap-3">
          {!loading && accounts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No accounts connected yet. Add one to start syncing a calendar.
            </p>
          )}

          {accounts.map((account) => (
            <SyncAccountCard
              account={account}
              busy={busyAccountId === account.id}
              key={account.id}
              onDisconnect={() => disconnect(account.id)}
              onRecolorCalendar={(id, enabled, color) => void recolorCalendar(id, enabled, color)}
              onResync={() => void resync(account.id)}
              onToggleCalendar={(id, enabled, color) => void toggleCalendar(id, enabled, color)}
              results={results}
            />
          ))}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div>
            <Button onClick={() => setAddOpen(true)} size="sm" variant="outline">
              <Plus className="size-3.5" />
              Add account
            </Button>
          </div>
        </div>

        <AddAccountDialog
          googleAvailable={googleAvailable}
          onConnect={connect}
          onConnectGoogle={connectGoogle}
          onOpenChange={setAddOpen}
          open={addOpen}
        />
      </SettingsSection>
    </div>
  );
}
