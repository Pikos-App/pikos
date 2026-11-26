// A focus stopwatch for the open page, at the end of the byline row. Deliberately quiet: a ghost
// icon button at rest, a monospaced elapsed count and a stop button while running. No target, chime
// or persistence of a running session (see `useFocusTimer`). Stopping writes one `focus_sessions`
// row, which the Data panel's "Focus time" card sums.

import { Play, Square } from "lucide-react";
import { useEffect } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { formatElapsed, MIN_SESSION_S, useFocusTimer } from "../hooks/useFocusTimer";

export function FocusTimer({ pageId }: { pageId: string }) {
  const { storage } = useWorkspace();
  const { setFocusZen } = useUI();
  const { elapsedS, running, start, stop } = useFocusTimer(storage, pageId);

  // Leaving the page banks the running session the same way stopping does, and
  // this component is keyed per page, so unmount is the other end of a session.
  useEffect(() => () => setFocusZen(false), [setFocusZen]);

  if (!running) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Start focus timer"
            className="inline-flex shrink-0 items-center rounded p-1 text-subtle transition-colors hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => {
              start();
              setFocusZen(true);
            }}
            type="button"
          >
            <Play aria-hidden="true" size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Start focus timer</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="inline-flex shrink-0 items-center gap-1.5">
      {/* aria-live so a screen reader user gets the running total on stop and on
          the coarse changes in between, without every second being announced. */}
      <span
        aria-live="off"
        className="type-mono text-muted-foreground tabular-nums"
        data-testid="focus-elapsed"
      >
        {formatElapsed(elapsedS)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Stop focus timer"
            className="inline-flex items-center rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => {
              setFocusZen(false);
              void stop();
            }}
            type="button"
          >
            <Square aria-hidden="true" fill="currentColor" size={11} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {elapsedS < MIN_SESSION_S
            ? `Stop. Under ${MIN_SESSION_S}s won't be recorded`
            : "Stop and record this session"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
