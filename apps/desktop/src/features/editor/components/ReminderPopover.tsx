// ReminderPopover — bell icon in the metadata byline.
// Shows per-page reminder configuration. If no reminders are set, the global
// default applies. Users can add specific lead times, set "None" to suppress
// all reminders for this page, or reset to the global default.

import type { PageReminder } from "@pikos/core";
import { Bell, BellOff, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { ReminderLeadTime } from "@/shared/context/AppSettingsContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

/** Sentinel value: minutes_before = -1 means "no reminders for this page." */
const NONE_SENTINEL = -1;

const LEAD_TIME_OPTIONS: { id: ReminderLeadTime; label: string }[] = [
  { id: 0, label: "At time of event" },
  { id: 5, label: "5 min before" },
  { id: 10, label: "10 min before" },
  { id: 15, label: "15 min before" },
  { id: 30, label: "30 min before" },
];

interface ReminderPopoverProps {
  pageId: string;
  /** Whether the page has a scheduled date — no bell if unscheduled. */
  hasSchedule: boolean;
}

export function ReminderPopover({ hasSchedule, pageId }: ReminderPopoverProps) {
  const { defaultReminderMinutes, notificationsEnabled } = useAppSettings();
  const { storage } = useWorkspace();
  const [reminders, setReminders] = useState<PageReminder[]>([]);
  const [open, setOpen] = useState(false);

  // Load reminders when popover opens or pageId changes
  useEffect(() => {
    if (!storage) return;
    void storage.listPageReminders(pageId).then(setReminders);
  }, [storage, pageId, open]);

  if (!hasSchedule) return null;

  const isNone = reminders.length === 1 && reminders[0]?.minutesBefore === NONE_SENTINEL;
  const activeReminders = reminders.filter((r) => r.minutesBefore !== NONE_SENTINEL);
  const hasCustomReminders = activeReminders.length > 0;

  async function handleAdd(minutes: ReminderLeadTime) {
    if (!storage) return;
    if (activeReminders.some((r) => r.minutesBefore === minutes)) return;
    // If currently "None", clear the sentinel first
    if (isNone) {
      await storage.deletePageReminders(pageId);
    }
    const created = await storage.createPageReminder({ minutesBefore: minutes, pageId });
    setReminders((prev) =>
      [...prev.filter((r) => r.minutesBefore !== NONE_SENTINEL), created].sort(
        (a, b) => a.minutesBefore - b.minutesBefore
      )
    );
  }

  async function handleRemove(id: string) {
    if (!storage) return;
    await storage.deletePageReminder(id);
    setReminders((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleSetNone() {
    if (!storage) return;
    await storage.deletePageReminders(pageId);
    const sentinel = await storage.createPageReminder({
      minutesBefore: NONE_SENTINEL,
      pageId,
    });
    setReminders([sentinel]);
  }

  async function handleResetToDefault() {
    if (!storage) return;
    await storage.deletePageReminders(pageId);
    setReminders([]);
  }

  const defaultLabel =
    LEAD_TIME_OPTIONS.find((o) => o.id === defaultReminderMinutes)?.label ??
    `${defaultReminderMinutes} min before`;

  const tooltipText = !notificationsEnabled
    ? "Notifications disabled"
    : isNone
      ? "Reminders off for this page"
      : hasCustomReminders
        ? `Custom reminders (${activeReminders.length})`
        : `Default: ${defaultLabel}`;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label="Page reminders"
              className={cn(
                "inline-flex items-center gap-1 rounded transition-colors hover:text-muted-foreground focus:outline-none",
                (!notificationsEnabled || isNone) && "opacity-40"
              )}
            >
              {isNone ? (
                <BellOff className="h-3.5 w-3.5" />
              ) : hasCustomReminders ? (
                <Bell className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Bell className="h-3.5 w-3.5" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipText}</TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-56 p-0" sideOffset={8}>
        <div className="p-3">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Reminders</p>

          {!notificationsEnabled && (
            <p className="mb-2 text-xs text-amber-500">
              Notifications are off globally. Enable in Settings.
            </p>
          )}

          {/* Current state display */}
          {isNone ? (
            <p className="mb-2 text-xs text-muted-foreground">None — no reminders for this page</p>
          ) : hasCustomReminders ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {activeReminders.map((r) => {
                const label =
                  LEAD_TIME_OPTIONS.find((o) => o.id === r.minutesBefore)?.label ??
                  `${r.minutesBefore} min`;
                return (
                  <span
                    className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"
                    key={r.id}
                  >
                    {label}
                    <button
                      aria-label={`Remove ${label} reminder`}
                      className="rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => void handleRemove(r.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="mb-2 text-xs text-muted-foreground">Using default: {defaultLabel}</p>
          )}

          {/* Add options */}
          <div className="space-y-0.5">
            {LEAD_TIME_OPTIONS.filter(
              (opt) => !activeReminders.some((r) => r.minutesBefore === opt.id)
            ).map((opt) => (
              <button
                className="flex w-full items-center rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                key={opt.id}
                onClick={() => void handleAdd(opt.id)}
              >
                + {opt.label}
              </button>
            ))}
          </div>

          {/* None option */}
          {!isNone && (
            <button
              className="mt-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => void handleSetNone()}
            >
              <BellOff className="h-3 w-3" />
              None
            </button>
          )}

          {/* Reset to default */}
          {(hasCustomReminders || isNone) && (
            <button
              className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => void handleResetToDefault()}
            >
              <Bell className="h-3 w-3" />
              Reset to default
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
