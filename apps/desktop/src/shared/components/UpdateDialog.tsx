import { AlertTriangle, Download, Loader2, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AutoUpdater } from "@/shared/hooks/useAutoUpdater";

interface UpdateDialogProps {
  updater: AutoUpdater;
}

export function UpdateDialog({ updater }: UpdateDialogProps) {
  const { status } = updater;

  if (status.state === "available") {
    return (
      <Dialog onOpenChange={(open) => !open && updater.dismiss()} open>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Pikos {status.update.version} is available</DialogTitle>
            <DialogDescription>
              You&apos;re currently on version {__APP_VERSION__}.
            </DialogDescription>
          </DialogHeader>

          {status.update.body && (
            <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground">
              <p className="mb-1 text-xs font-medium text-muted-foreground">What&apos;s new</p>
              <div className="whitespace-pre-wrap">{status.update.body}</div>
            </div>
          )}

          <DialogFooter className="sm:justify-between">
            <Button onClick={updater.skipVersion} size="sm" variant="ghost">
              <SkipForward className="size-3.5" />
              Skip this version
            </Button>
            <div className="flex gap-2">
              <Button onClick={updater.dismiss} size="sm" variant="outline">
                Later
              </Button>
              <Button autoFocus onClick={updater.installUpdate} size="sm">
                <Download className="size-3.5" />
                Update now
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (status.state === "downloading") {
    return (
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Installing update…</DialogTitle>
            <DialogDescription>Pikos will restart automatically.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Show a dialog for install failures only — check failures (background
  // auto-check or "Check now") surface inline in the About card and shouldn't
  // pop a modal over the user's first session.
  if (status.state === "error" && status.scope === "install") {
    return (
      <Dialog onOpenChange={(open) => !open && updater.dismiss()} open>
        <DialogContent>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              <DialogTitle>Update failed</DialogTitle>
            </div>
            <DialogDescription>{status.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus onClick={updater.dismiss} size="sm">
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return null;
}
