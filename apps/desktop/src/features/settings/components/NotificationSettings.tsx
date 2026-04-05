// NotificationSettings — global on/off switch + default reminder lead time.

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

export function NotificationSettings() {
  const {
    defaultReminderMinutes,
    notificationsEnabled,
    setDefaultReminderMinutes,
    setNotificationsEnabled,
  } = useAppSettings();

  return (
    <div className="max-w-lg">
      <section className="mb-8">
        <h2 className="mb-1 text-base font-semibold">Notifications</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Desktop reminders for scheduled pages. Notifications are fully local — nothing leaves your
          device.
        </p>

        <div className="rounded-lg border border-border bg-card px-4">
          {/* Global toggle */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Enable notifications</p>
              <p className="text-xs text-muted-foreground">
                Send desktop reminders for upcoming scheduled pages.
              </p>
            </div>
            <Switch checked={notificationsEnabled} onCheckedChange={setNotificationsEnabled} />
          </div>

          {/* Default lead time */}
          <div
            className={cn(
              "py-3 transition-opacity",
              !notificationsEnabled && "pointer-events-none opacity-40"
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
        </div>
      </section>
    </div>
  );
}
