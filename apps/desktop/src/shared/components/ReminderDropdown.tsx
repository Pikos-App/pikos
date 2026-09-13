import { Bell, BellOff, Check } from "lucide-react";
import { useEffect } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DAY_BEFORE_SENTINEL,
  type PageReminderChoice,
  usePageReminders,
} from "@/features/editor/hooks/usePageReminders";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { ReminderLeadTime } from "@/shared/context/AppSettingsContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

const LEAD_TIME_OPTIONS: { id: ReminderLeadTime; label: string }[] = [
  { id: 0, label: "At time of event" },
  { id: 5, label: "5 min before" },
  { id: 10, label: "10 min before" },
  { id: 15, label: "15 min before" },
  { id: 30, label: "30 min before" },
  { id: 60, label: "1 hour before" },
  { id: 120, label: "2 hours before" },
  { id: 1440, label: "1 day before" },
];

// An all-day page has no start time, so no lead time can anchor its reminder —
// it gets one option, resolved against the date by the scheduler's day-before
// arm (`pikos_db::due_day_before_reminders`).
const ALL_DAY_OPTIONS: { id: PageReminderChoice; label: string }[] = [
  { id: DAY_BEFORE_SENTINEL, label: "Day before at 9:00" },
];

export interface ReminderDropdownProps {
  pageId: string;
  /** Icon size in pixels. Default 14 (3.5 tailwind). */
  iconSize?: number;
  /** The page is scheduled all-day, so it takes the day-before anchor instead of
   *  lead times. Callers derive it from the schedule they already hold. */
  allDay?: boolean;
}

export function ReminderDropdown({ allDay = false, iconSize = 14, pageId }: ReminderDropdownProps) {
  const { defaultReminderMinutes, notificationsEnabled } = useAppSettings();
  const { storage } = useWorkspace();

  const {
    activeReminders,
    add,
    hasCustomReminders,
    isNone,
    load,
    remove,
    resetToDefault,
    setNone,
  } = usePageReminders(storage, pageId);

  useEffect(() => {
    void load();
  }, [storage, pageId]);

  const options = allDay ? ALL_DAY_OPTIONS : LEAD_TIME_OPTIONS;

  function handleToggle(minutes: PageReminderChoice) {
    const existing = activeReminders.find((r) => r.minutesBefore === minutes);
    if (existing) {
      void remove(existing.id);
    } else {
      void add(minutes);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Page reminders"
          className={cn(
            "inline-flex items-center rounded transition-colors hover:text-muted-foreground focus:outline-none",
            (!notificationsEnabled || isNone) && "opacity-40"
          )}
        >
          {isNone ? (
            <BellOff style={{ height: iconSize, width: iconSize }} />
          ) : hasCustomReminders ? (
            <Bell className="fill-current" style={{ height: iconSize, width: iconSize }} />
          ) : (
            <Bell style={{ height: iconSize, width: iconSize }} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {!notificationsEnabled && (
          <div className="px-2 py-1.5 text-xs text-amber-500">Notifications off globally</div>
        )}

        <DropdownMenuItem
          className={cn(
            "justify-between",
            isNone ? "font-medium text-foreground" : "text-muted-foreground"
          )}
          onClick={() => void (isNone ? resetToDefault() : setNone())}
        >
          <span className="flex items-center gap-2">
            <BellOff className="h-3.5 w-3.5 shrink-0" />
            <span>None</span>
          </span>
          {isNone && <Check className="shrink-0 text-foreground" size={12} strokeWidth={2.5} />}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {options.map((opt) => {
          const isExplicit = activeReminders.some((r) => r.minutesBefore === opt.id);
          // The global default is a lead time, so it never stands in for an
          // all-day page — which is why an all-day page reminds only when the
          // user asks it to.
          const isDefault =
            !allDay && !hasCustomReminders && !isNone && opt.id === defaultReminderMinutes;
          const isActive = isExplicit || isDefault;
          return (
            <DropdownMenuItem
              className={cn(
                "justify-between",
                isActive ? "font-medium text-foreground" : "text-muted-foreground"
              )}
              key={opt.id}
              onClick={() => handleToggle(opt.id)}
            >
              <span className="flex items-center gap-2">
                <Bell className="h-3.5 w-3.5 shrink-0" />
                <span>{opt.label}</span>
              </span>
              {isActive && (
                <Check className="shrink-0 text-foreground" size={12} strokeWidth={2.5} />
              )}
            </DropdownMenuItem>
          );
        })}

        {(hasCustomReminders || isNone) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-muted-foreground"
              onClick={() => void resetToDefault()}
            >
              {/* An all-day page has no default to fall back to — clearing its
                  rows leaves it with no reminder, so don't call it a reset. */}
              {allDay ? "Clear" : "Reset to default"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
