import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Switch } from "@/components/ui/switch";

import { type ICloudSyncAction, useICloudSync } from "../hooks/useICloudSync";
import { SettingsSection } from "./SettingsSection";

const ACTION_LABELS: Record<Exclude<ICloudSyncAction, "none">, string> = {
  uploadAgain: "Upload this Mac's pages again",
  useThisAccount: "Sync with this account",
};

export function ICloudSyncSettings() {
  const { act, copyReport, error, setOn, state } = useICloudSync();
  const [copied, setCopied] = useState(false);
  const action = state && state.action !== "none" ? ACTION_LABELS[state.action] : null;

  async function handleCopyReport() {
    const isCopied = await copyReport();
    if (!isCopied) return;

    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

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
          <div className="flex items-center justify-between gap-3 border-t border-border py-3">
            <div>
              <p className="text-sm font-medium">Sync report</p>
              <p className="text-xs text-muted-foreground">
                Copies this Mac's sync state and log, with no page titles or text, to paste into a
                message.
              </p>
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
              onClick={() => void handleCopyReport()}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
