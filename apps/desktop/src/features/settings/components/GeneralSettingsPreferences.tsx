import { cn } from "@/lib/utils";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";
import type { CalendarDayCount, CalendarDensity } from "@/shared/constants/calendar";
import { IS_LINUX } from "@/shared/constants/platform";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { WeekStart } from "@/shared/context/AppSettingsContext";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import type { LineWidth } from "@/shared/context/EditorSettingsContext";
import { useListSettings } from "@/shared/context/ListSettingsContext";
import type { ListDensity } from "@/shared/context/ListSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import type { ThemeMode } from "@/shared/context/ThemeContext";
import { useTheme } from "@/shared/context/ThemeContext";

import { SettingChoice } from "./SettingChoice";
import { SettingsSection } from "./SettingsSection";

const THEME_OPTIONS: readonly { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  // "System" hidden on Linux — WebKit2GTK's prefers-color-scheme is unreliable.
  ...(IS_LINUX ? [] : [{ id: "system" as const, label: "System" }]),
];

const LINE_WIDTH_OPTIONS: readonly { id: LineWidth; label: string }[] = [
  { id: "narrow", label: "Narrow" },
  { id: "default", label: "Default" },
  { id: "wide", label: "Wide" },
  { id: "full", label: "Full" },
];

const CALENDAR_DAY_COUNT_OPTIONS: readonly { id: CalendarDayCount; label: string }[] = [
  { id: 1, label: "1" },
  { id: 3, label: "3" },
  { id: 5, label: "5" },
  { id: "mf", label: "M–F" },
  { id: 7, label: "7" },
];

const CALENDAR_DENSITY_OPTIONS: readonly { id: CalendarDensity; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "normal", label: "Normal" },
  { id: "spacious", label: "Spacious" },
];

const LIST_DENSITY_OPTIONS: readonly { id: ListDensity; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "cozy", label: "Cozy" },
  { id: "spacious", label: "Spacious" },
];

const WEEK_START_OPTIONS: readonly { id: WeekStart; label: string }[] = [
  { id: 1, label: "Monday" },
  { id: 0, label: "Sunday" },
];

export function GeneralSettingsPreferences() {
  const { folders } = usePages();
  const { defaultFolderId, setDefaultFolderId, setWeekStart, weekStart } = useAppSettings();
  const { mode, setTheme } = useTheme();
  const { lineWidth, setLineWidth } = useEditorSettings();
  const {
    dayCount: calendarDayCount,
    density: calendarDensity,
    setDayCount: setCalendarDayCount,
    setDensity: setCalendarDensity,
  } = useCalendarSettings();
  const { density: listDensity, setDensity: setListDensity } = useListSettings();

  return (
    <SettingsSection title="Preferences">
      <div className="rounded-lg border border-border bg-card px-4">
        <SettingChoice
          description="Choose how Pikos looks."
          label="Theme"
          onChange={setTheme}
          options={THEME_OPTIONS}
          value={mode}
        />
        <SettingChoice
          description="How tightly rows pack in the page and folder lists."
          label="List density"
          onChange={setListDensity}
          options={LIST_DENSITY_OPTIONS}
          value={listDensity}
        />
        <SettingChoice
          description="How wide the text area is."
          label="Editor line width"
          onChange={setLineWidth}
          options={LINE_WIDTH_OPTIONS}
          value={lineWidth}
        />
        <SettingChoice
          description="Number of day columns in the calendar. Narrow windows may show fewer."
          label="Calendar days shown"
          onChange={setCalendarDayCount}
          options={CALENDAR_DAY_COUNT_OPTIONS}
          value={calendarDayCount}
        />
        <SettingChoice
          description="How tall each hour row renders."
          label="Calendar density"
          onChange={setCalendarDensity}
          options={CALENDAR_DENSITY_OPTIONS}
          value={calendarDensity}
        />
        <SettingChoice
          description="Controls the calendar and date picker layout."
          label="Week starts on"
          onChange={setWeekStart}
          options={WEEK_START_OPTIONS}
          value={weekStart}
        />

        {/* Default folder uses a searchable popover, not a button group. */}
        <div className="flex items-center justify-between py-3">
          <div>
            <p className="text-sm font-medium">Default folder for new pages</p>
            <p className="text-xs text-muted-foreground">
              Used when no folder is selected in the sidebar.
            </p>
          </div>
          <SearchablePopover
            align="end"
            placeholder="Search folders…"
            trigger={
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent">
                {folders.find((f) => f.id === defaultFolderId)?.name ?? "Inbox"}
              </button>
            }
          >
            {({ close }) => (
              <>
                <SettingsPopoverItem
                  onClick={() => {
                    setDefaultFolderId(null);
                    close();
                  }}
                  selected={defaultFolderId === null}
                >
                  Inbox
                </SettingsPopoverItem>
                {folders.map((f) => (
                  <SettingsPopoverItem
                    key={f.id}
                    onClick={() => {
                      setDefaultFolderId(f.id);
                      close();
                    }}
                    selected={defaultFolderId === f.id}
                  >
                    {f.name}
                  </SettingsPopoverItem>
                ))}
              </>
            )}
          </SearchablePopover>
        </div>
      </div>
    </SettingsSection>
  );
}

function SettingsPopoverItem({
  children,
  onClick,
  selected,
}: {
  children: React.ReactNode;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <SearchablePopoverItem
      className={cn(selected ? "font-medium text-foreground" : "text-muted-foreground")}
      onClick={onClick}
    >
      {children}
    </SearchablePopoverItem>
  );
}
