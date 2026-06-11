// Renders inside the failed pane only — the rest of the app shell stays interactive.

import { Button } from "@/components/ui/button";

interface PaneErrorFallbackProps {
  /** What the user thinks of as the failed surface ("Editor", "Calendar", "Settings"). */
  label: string;
  error: Error;
  onReset: () => void;
}

export function PaneErrorFallback({ error, label, onReset }: PaneErrorFallbackProps) {
  return (
    <div className="flex h-full items-center justify-center bg-background px-4 py-8 text-foreground">
      <div className="w-full max-w-sm">
        <p className="text-sm font-medium">{label} crashed</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try again. If it keeps happening, relaunch the app.
        </p>
        <div className="mt-3">
          <Button onClick={onReset} size="sm" variant="outline">
            Try again
          </Button>
        </div>
        <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {error.message}
        </pre>
      </div>
    </div>
  );
}
