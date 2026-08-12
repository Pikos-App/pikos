import type { CalendarSyncResult, SyncCalendar } from "@pikos/core";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { PALETTE_COLORS } from "@/shared/constants/colors";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";

import { calendarSyncDot } from "./syncStatus";
import { SyncStatusDot } from "./SyncStatusDot";

interface SyncCalendarRowProps {
  calendar: SyncCalendar;
  lastResult?: CalendarSyncResult["status"] | undefined;
  onToggle: (enabled: boolean) => void;
  onRecolor: (color: string) => void;
}

export function SyncCalendarRow({
  calendar,
  lastResult,
  onRecolor,
  onToggle,
}: SyncCalendarRowProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Re-render each minute so "synced N ago" and the stale dot stay current
  // without a user interaction, since both derive from the wall clock.
  useMinuteTick();
  const dot = calendarSyncDot(calendar, lastResult);
  const swatch = calendar.color ?? "var(--text-tertiary)";
  const kept = calendar.detachedPages;

  // Turning a calendar back on is the one toggle that overwrites work the user did
  // while it was off, and nothing else warns them — the page-level banner says the
  // opposite ("a regular page you can edit"). Only asks when pages are actually
  // waiting to be reclaimed; every other flip stays instant.
  function toggle(next: boolean) {
    if (next && kept > 0) {
      setConfirmOpen(true);
      return;
    }
    onToggle(next);
  }

  return (
    <div className="flex items-center gap-2.5 py-2">
      <Switch
        aria-label={`Sync ${calendar.displayName}`}
        checked={calendar.enabled}
        onCheckedChange={toggle}
        size="sm"
      />

      <div className="relative">
        <button
          aria-label={`Colour for ${calendar.displayName}`}
          className="size-3 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setPickerOpen((o) => !o)}
          style={{ backgroundColor: swatch }}
        />
        {pickerOpen && (
          <>
            <button
              aria-hidden
              className="fixed inset-0 z-10 cursor-default"
              onClick={() => setPickerOpen(false)}
              tabIndex={-1}
            />
            <div className="absolute top-5 left-0 z-20 grid grid-cols-8 gap-1.5 rounded-md border border-border bg-popover p-2 shadow-md">
              {PALETTE_COLORS.map(({ label, value }) => (
                <button
                  aria-label={label}
                  className="size-4 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  key={value}
                  onClick={() => {
                    onRecolor(value);
                    setPickerOpen(false);
                  }}
                  style={{ backgroundColor: value }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <span className="min-w-0 flex-1 truncate text-sm">{calendar.displayName}</span>

      {calendar.enabled && calendar.lastSyncedAt && (
        <span className="shrink-0 text-xs text-muted-foreground">
          synced {formatDistanceToNow(new Date(calendar.lastSyncedAt), { addSuffix: true })}
        </span>
      )}

      <SyncStatusDot label={`${calendar.displayName}: ${dot.label}`} state={dot.state} />

      <ConfirmDialog
        confirmLabel="Turn on"
        description={`You kept ${kept} ${kept === 1 ? "page" : "pages"} when this calendar was off. Turning it back on takes back their title, time, and folder. Anything you wrote on them stays.`}
        onConfirm={() => {
          setConfirmOpen(false);
          onToggle(true);
        }}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        title={`Turn ${calendar.displayName} back on?`}
      />
    </div>
  );
}
