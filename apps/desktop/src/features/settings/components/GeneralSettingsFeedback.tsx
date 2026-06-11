import { appLogDir, join } from "@tauri-apps/api/path";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Bug, Check, Copy, FileText } from "lucide-react";
import { useState } from "react";

import { IS_MACOS } from "@/shared/constants/platform";
import { createLogger } from "@/shared/logger";

import { SettingsSection } from "./SettingsSection";

const log = createLogger("GeneralSettingsFeedback");

export function GeneralSettingsFeedback() {
  return (
    <SettingsSection
      description="Found a bug or have a suggestion? I'd love to hear from you."
      title="Feedback"
    >
      <div className="rounded-lg border border-border bg-card px-4">
        <CopyEmailRow />

        <div className="flex items-center justify-between border-t border-border py-3">
          <div>
            <p className="text-sm font-medium">Report a bug…</p>
            <p className="text-xs text-muted-foreground">
              Opens pikos.app with your version info pre-filled.
            </p>
          </div>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            onClick={() => {
              const os = IS_MACOS ? "macOS" : "Linux";
              const params = new URLSearchParams({ os, version: __APP_VERSION__ });
              void openUrl(`https://pikos.app/bugs?${params.toString()}`);
            }}
          >
            <Bug className="h-3.5 w-3.5" />
            Report
          </button>
        </div>

        <div className="flex items-center justify-between border-t border-border py-3">
          <div>
            <p className="text-sm font-medium">Open log file</p>
            <p className="text-xs text-muted-foreground">
              Opens pikos.log so you can review and copy what to share.
            </p>
          </div>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            onClick={() => void handleOpenLogFile()}
          >
            <FileText className="h-3.5 w-3.5" />
            Open
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}

async function handleOpenLogFile() {
  try {
    await openPath(await join(await appLogDir(), "pikos.log"));
  } catch (err) {
    log.warn("open log file failed", err);
  }
}

function CopyEmailRow() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText("hello@pikos.app");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      log.warn("clipboard write failed", err);
    }
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium">Send feedback</p>
        <p className="text-xs text-muted-foreground">hello@pikos.app</p>
      </div>
      <button
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        onClick={() => void handleCopy()}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy email"}
      </button>
    </div>
  );
}
