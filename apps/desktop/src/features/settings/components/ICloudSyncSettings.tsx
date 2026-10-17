import { Switch } from "@/components/ui/switch";

import { type ICloudSyncAction, useICloudSync } from "../hooks/useICloudSync";
import { SettingsSection } from "./SettingsSection";

const ACTION_LABELS: Record<Exclude<ICloudSyncAction, "none">, string> = {
  uploadAgain: "Upload this Mac's pages again",
  useThisAccount: "Sync with this account",
};

export function ICloudSyncSettings() {
  const { act, error, setOn, state } = useICloudSync();
  const action = state && state.action !== "none" ? ACTION_LABELS[state.action] : null;

  return (
    <SettingsSection
      description="Keeps your pages the same on every device signed in to your iCloud account."
      title="iCloud"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <label className="text-sm font-medium" htmlFor="icloud-sync">
          Sync with iCloud
        </label>
        <Switch
          checked={state?.on ?? false}
          disabled={state === null}
          id="icloud-sync"
          onCheckedChange={(on) => void setOn(on)}
        />
      </div>
      {state && <p className="mt-3 text-xs text-muted-foreground">{state.text}</p>}
      {action && (
        <button
          className="mt-3 inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
          onClick={() => void act()}
        >
          {action}
        </button>
      )}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </SettingsSection>
  );
}
