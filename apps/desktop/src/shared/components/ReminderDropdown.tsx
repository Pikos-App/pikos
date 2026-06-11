import { Bell, BellOff, Check } from "lucide-react";
import { useEffect } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePageReminders } from "@/features/editor/hooks/usePageReminders";
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
];

interface ReminderDropdownProps {
  pageId: string;
  /** Icon size in pixels. Default 14 (3.5 tailwind). */
  iconSize?: number;
}

export function ReminderDropdown({ iconSize = 14, pageId }: ReminderDropdownProps) {
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

  function handleToggle(minutes: ReminderLeadTime) {
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

        {LEAD_TIME_OPTIONS.map((opt) => {
          const isExplicit = activeReminders.some((r) => r.minutesBefore === opt.id);
          const isDefault = !hasCustomReminders && !isNone && opt.id === defaultReminderMinutes;
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
              Reset to default
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
