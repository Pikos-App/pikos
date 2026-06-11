import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertCircle, CheckCircle, ExternalLink, Loader2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useUpdate } from "@/shared/context/UpdateContext";

import { SettingsSection } from "./SettingsSection";

export function GeneralSettingsAbout() {
  const updater = useUpdate();
  const { autoUpdateEnabled, setAutoUpdateEnabled } = useAppSettings();

  return (
    <SettingsSection title="About">
      <div className="rounded-lg border border-border bg-card px-4">
        <div className="flex items-start justify-between gap-4 border-b border-border py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Pikos</p>
            <p className="text-xs text-muted-foreground">
              Version {__APP_VERSION__}
              {import.meta.env.DEV && " — dev"}
            </p>
            {updater.status.state === "checking" ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Checking for updates…</p>
              </div>
            ) : updater.status.state === "up-to-date" ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                <p className="text-xs text-muted-foreground">You’re on the latest version</p>
              </div>
            ) : updater.status.state === "error" ? (
              <div className="mt-1.5 flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <p className="text-xs text-destructive">{updater.status.message}</p>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border py-3">
          <label className="text-sm font-medium" htmlFor="general-auto-updates">
            Check for updates automatically
          </label>
          <div className="flex items-center gap-3">
            <button
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={updater.status.state === "checking"}
              onClick={() => updater.checkForUpdates()}
            >
              Check now
            </button>
            <Switch
              checked={autoUpdateEnabled}
              id="general-auto-updates"
              onCheckedChange={setAutoUpdateEnabled}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <button
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => void openUrl("https://pikos.app")}
          >
            Website <ExternalLink className="h-3 w-3" />
          </button>
          <button
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => void openUrl("https://pikos.app/release-notes")}
          >
            Release Notes <ExternalLink className="h-3 w-3" />
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}
