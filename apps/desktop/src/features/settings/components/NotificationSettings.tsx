// NotificationSettings — global on/off, default lead time, overdue alerts, quiet hours.

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { ReminderLeadTime } from "@/shared/context/AppSettingsContext";

const LEAD_TIME_OPTIONS: { id: ReminderLeadTime; label: string }[] = [
  { id: 0, label: "At time of event" },
  { id: 5, label: "5 min before" },
  { id: 10, label: "10 min before" },
  { id: 15, label: "15 min before" },
  { id: 30, label: "30 min before" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);

function formatTime24to12(time: string): string {
  const parts = time.split(":").map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

export function NotificationSettings() {
  const {
    defaultReminderMinutes,
    notificationsEnabled,
    overdueAlerts,
    quietHoursEnabled,
    quietHoursEnd,
    quietHoursStart,
    setDefaultReminderMinutes,
    setNotificationsEnabled,
    setOverdueAlerts,
    setQuietHoursEnabled,
    setQuietHoursEnd,
    setQuietHoursStart,
    setSummaryTime,
    summaryTime,
  } = useAppSettings();

  // Permission state
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);

  useEffect(() => {
    void checkPermission();
  }, []);

  async function checkPermission() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const granted = await invoke<boolean>("check_notification_permission");
      setPermissionGranted(granted);
      return granted;
    } catch {
      setPermissionGranted(null);
      return null;
    }
  }

  async function handleRequestPermission() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const granted = await invoke<boolean>("request_notification_permission");
      setPermissionGranted(granted);
    } catch {
      // Platform doesn't support permission requests or Tauri unavailable
    }
  }

  // Request permission when the user enables notifications
  async function handleToggleEnabled(enabled: boolean) {
    setNotificationsEnabled(enabled);
    if (enabled) {
      const alreadyGranted = await checkPermission();
      if (!alreadyGranted) {
        await handleRequestPermission();
      }
    }
  }

  const disabled = !notificationsEnabled;

  return (
    <div className="max-w-lg">
      <section className="mb-8">
        <h2 className="mb-1 text-base font-semibold">Notifications</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Desktop reminders for scheduled pages. Notifications are fully local — nothing leaves your
          device.
        </p>

        {/* Permission blocked warning */}
        {permissionGranted === false && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Notifications blocked by your system
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pikos can't send desktop notifications until you allow them in your system settings.
              </p>
              <button
                className="mt-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                onClick={() => void handleRequestPermission()}
              >
                Request permission
              </button>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-border bg-card px-4">
          {/* Global toggle */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Enable notifications</p>
              <p className="text-xs text-muted-foreground">
                Send desktop reminders for upcoming scheduled pages.
              </p>
            </div>
            <Switch
              checked={notificationsEnabled}
              onCheckedChange={(v) => void handleToggleEnabled(v)}
            />
          </div>

          {/* Default lead time */}
          <div
            className={cn(
              "border-b border-border py-3 transition-opacity",
              disabled && "pointer-events-none opacity-40"
            )}
          >
            <div className="mb-3">
              <p className="text-sm font-medium">Default reminder time</p>
              <p className="text-xs text-muted-foreground">
                Applied to all scheduled pages unless overridden per-page.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {LEAD_TIME_OPTIONS.map((opt) => (
                <button
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                    defaultReminderMinutes === opt.id
                      ? "border-foreground/20 bg-accent text-accent-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                  key={opt.id}
                  onClick={() => setDefaultReminderMinutes(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Daily summary */}
          <div
            className={cn(
              "border-b border-border py-3 transition-opacity",
              disabled && "pointer-events-none opacity-40"
            )}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Daily summary</p>
                <p className="text-xs text-muted-foreground">
                  One notification per day with today's schedule and overdue items. Deferred if
                  inside quiet hours.
                </p>
              </div>
              <Switch checked={overdueAlerts} onCheckedChange={setOverdueAlerts} />
            </div>

            {overdueAlerts && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Fire at</span>
                <Select onValueChange={setSummaryTime} value={summaryTime}>
                  <SelectTrigger
                    aria-label="Daily summary time"
                    className="h-auto w-[100px] rounded-md border px-2.5 py-1.5 text-xs font-medium"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {formatTime24to12(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Quiet hours */}
          <div
            className={cn("py-3 transition-opacity", disabled && "pointer-events-none opacity-40")}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Quiet hours</p>
                <p className="text-xs text-muted-foreground">
                  Suppress notifications during a time window.
                </p>
              </div>
              <Switch checked={quietHoursEnabled} onCheckedChange={setQuietHoursEnabled} />
            </div>

            {quietHoursEnabled && (
              <div className="mt-3 flex items-center gap-2">
                <Select onValueChange={setQuietHoursStart} value={quietHoursStart}>
                  <SelectTrigger
                    aria-label="Quiet hours start"
                    className="h-auto w-[100px] rounded-md border px-2.5 py-1.5 text-xs font-medium"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {formatTime24to12(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">to</span>
                <Select onValueChange={setQuietHoursEnd} value={quietHoursEnd}>
                  <SelectTrigger
                    aria-label="Quiet hours end"
                    className="h-auto w-[100px] rounded-md border px-2.5 py-1.5 text-xs font-medium"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {formatTime24to12(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
