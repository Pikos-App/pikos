import type { CalendarDayCount, CalendarDensity } from "@pikos/core";

import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";
import { IS_LINUX } from "@/shared/constants/platform";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { WeekStart } from "@/shared/context/AppSettingsContext";
import {
  CALENDAR_TEXT_SIZES,
  type CalendarTextSize,
  useCalendarSettings,
} from "@/shared/context/CalendarSettingsContext";
import { EDITOR_FONT_SIZES, useEditorSettings } from "@/shared/context/EditorSettingsContext";
import type { EditorFontSize, LineWidth } from "@/shared/context/EditorSettingsContext";
import {
  type InterfaceTextScale,
  useInterfaceSettings,
} from "@/shared/context/InterfaceSettingsContext";
import type { ListDensity } from "@/shared/context/InterfaceSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import type { ThemeMode } from "@/shared/context/ThemeContext";
import { useTheme } from "@/shared/context/ThemeContext";

import { SettingChoice } from "./SettingChoice";
import { PickerTrigger } from "./SettingPicker";
import { SettingSelect } from "./SettingSelect";
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

const FONT_SIZE_OPTIONS: readonly { id: EditorFontSize; label: string }[] = EDITOR_FONT_SIZES.map(
  (size) => ({ id: size, label: String(size) })
);

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

/** The interface has no single body size for a px to refer to, so it names
 *  its steps. The editor and calendar each do have one and name the px
 *  (PKOS-0067: shared control shape, per-area vocabulary). */
const TEXT_SCALE_OPTIONS: readonly { id: InterfaceTextScale; label: string }[] = [
  { id: 0.85, label: "Smaller" },
  { id: 1, label: "Default" },
  { id: 1.15, label: "Large" },
  { id: 1.3, label: "Larger" },
  { id: 1.5, label: "Huge" },
  { id: 1.75, label: "Huger" },
  { id: 2, label: "Largest" },
];

const CALENDAR_TEXT_SIZE_OPTIONS: readonly { id: CalendarTextSize; label: string }[] =
  CALENDAR_TEXT_SIZES.map((size) => ({ id: size, label: String(size) }));

const WEEK_START_OPTIONS: readonly { id: WeekStart; label: string }[] = [
  { id: 1, label: "Monday" },
  { id: 0, label: "Sunday" },
];

export function GeneralSettingsPreferences() {
  const { folders } = usePages();
  const { defaultFolderId, setDefaultFolderId, setWeekStart, weekStart } = useAppSettings();
  const { mode, setTheme } = useTheme();
  const { fontSize, lineWidth, setFontSize, setLineWidth } = useEditorSettings();
  const {
    dayCount: calendarDayCount,
    density: calendarDensity,
    setDayCount: setCalendarDayCount,
    setDensity: setCalendarDensity,
    setTextSize: setCalendarTextSize,
    textSize: calendarTextSize,
  } = useCalendarSettings();
  const {
    density: listDensity,
    setDensity: setListDensity,
    setTextScale: setInterfaceTextScale,
    textScale: interfaceTextScale,
  } = useInterfaceSettings();
  const defaultFolderName = folders.find((f) => f.id === defaultFolderId)?.name ?? "Inbox";

  return (
    <SettingsSection title="Preferences">
      <div className="mb-3 rounded-lg border border-border bg-card px-4">
        <SettingChoice
          description="Choose how Pikos looks."
          label="Theme"
          onChange={setTheme}
          options={THEME_OPTIONS}
          value={mode}
        />
      </div>
      <div className="mb-3 rounded-lg border border-border bg-card px-4">
        <SettingSelect
          description="Text size in the sidebar, lists, dialogs and menus. ⌘+ and ⌘− change this while Settings is open."
          label="Interface text size"
          onChange={setInterfaceTextScale}
          options={TEXT_SCALE_OPTIONS}
          value={interfaceTextScale}
        />
        <SettingChoice
          description="How tightly rows pack in the page and folder lists."
          label="Interface density"
          onChange={setListDensity}
          options={LIST_DENSITY_OPTIONS}
          value={listDensity}
        />
      </div>
      <div className="mb-3 rounded-lg border border-border bg-card px-4">
        <SettingSelect
          description="Body text size in the editor."
          label="Editor text size"
          onChange={setFontSize}
          options={FONT_SIZE_OPTIONS}
          value={fontSize}
        />
        <SettingChoice
          description="How wide the text area is."
          label="Editor line width"
          onChange={setLineWidth}
          options={LINE_WIDTH_OPTIONS}
          value={lineWidth}
        />
      </div>
      <div className="mb-3 rounded-lg border border-border bg-card px-4">
        <SettingSelect
          description="Text size for event titles and time labels."
          label="Calendar text size"
          onChange={setCalendarTextSize}
          options={CALENDAR_TEXT_SIZE_OPTIONS}
          value={calendarTextSize}
        />
        <SettingChoice
          description="How tall each hour row renders."
          label="Calendar density"
          onChange={setCalendarDensity}
          options={CALENDAR_DENSITY_OPTIONS}
          value={calendarDensity}
        />
        <SettingChoice
          description="Number of day columns in the calendar. Narrow windows may show fewer."
          label="Calendar days shown"
          onChange={setCalendarDayCount}
          options={CALENDAR_DAY_COUNT_OPTIONS}
          value={calendarDayCount}
        />
        <SettingChoice
          description="Controls the calendar and date picker layout."
          label="Week starts on"
          onChange={setWeekStart}
          options={WEEK_START_OPTIONS}
          value={weekStart}
        />
      </div>
      <div className="rounded-lg border border-border bg-card px-4">
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
              <PickerTrigger ariaLabel={`Default folder for new pages: ${defaultFolderName}`}>
                {defaultFolderName}
              </PickerTrigger>
            }
          >
            {({ close }) => (
              <>
                <SearchablePopoverItem
                  onClick={() => {
                    setDefaultFolderId(null);
                    close();
                  }}
                  selected={defaultFolderId === null}
                >
                  Inbox
                </SearchablePopoverItem>
                {folders.map((f) => (
                  <SearchablePopoverItem
                    key={f.id}
                    onClick={() => {
                      setDefaultFolderId(f.id);
                      close();
                    }}
                    selected={defaultFolderId === f.id}
                  >
                    {f.name}
                  </SearchablePopoverItem>
                ))}
              </>
            )}
          </SearchablePopover>
        </div>
      </div>
    </SettingsSection>
  );
}
