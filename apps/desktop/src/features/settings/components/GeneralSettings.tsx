// The destructive Delete-All-Data flow lives in Data settings (data-lifecycle
// coherence + safety-adjacency to Export).

import { GeneralSettingsAbout } from "./GeneralSettingsAbout";
import { GeneralSettingsFeedback } from "./GeneralSettingsFeedback";
import { GeneralSettingsPreferences } from "./GeneralSettingsPreferences";

export function GeneralSettings() {
  return (
    <div className="max-w-lg">
      <GeneralSettingsAbout />
      <GeneralSettingsPreferences />
      <GeneralSettingsFeedback />
    </div>
  );
}
