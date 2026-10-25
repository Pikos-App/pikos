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
    <div className="max-w-settings">
      <SettingsSection
        description="Keeps your pages the same on every device signed in to your iCloud account."
        title="iCloud"
      >
        <div className="rounded-lg border border-border bg-card px-4">
          <div className="flex items-center justify-between gap-3 py-3">
            <div>
              <label className="text-sm font-medium" htmlFor="icloud-sync">
                Sync with iCloud
              </label>
              {state && <p className="text-xs text-muted-foreground">{state.text}</p>}
            </div>
            <Switch
              checked={state?.on ?? false}
              disabled={state === null}
              id="icloud-sync"
              onCheckedChange={(on) => void setOn(on)}
            />
          </div>
          {(action || error) && (
            <div className="flex flex-col items-start gap-2 border-t border-border py-3">
              {error && <p className="text-xs text-destructive">{error}</p>}
              {action && (
                <button
                  className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
                  onClick={() => void act()}
                >
                  {action}
                </button>
              )}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
