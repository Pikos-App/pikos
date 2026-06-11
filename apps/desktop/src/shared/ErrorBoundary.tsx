import { Bug, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { IS_MACOS } from "@/shared/constants/platform";
import { createLogger, formatError } from "@/shared/logger";

const log = createLogger("ErrorBoundary");

interface Props {
  children: ReactNode;
  /** Optional custom fallback. When omitted, the full-screen "Something went
   *  wrong" shell renders. Pass a compact alternative when wrapping individual
   *  panes/dialogs so one pane's crash doesn't blank the whole window. */
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
  detailsOpen: boolean;
  copied: boolean;
}

const INITIAL_STATE: State = {
  componentStack: null,
  copied: false,
  detailsOpen: false,
  error: null,
  hasError: false,
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = INITIAL_STATE;
  copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Component stack contains React component names only — safe to log.
    // Error is sanitized (paths scrubbed) by the logger before file write.
    log.error(`Render error in${info.componentStack ?? ""}`, error);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentWillUnmount() {
    if (this.copyResetTimer !== null) clearTimeout(this.copyResetTimer);
  }

  reset = () => {
    if (this.copyResetTimer !== null) clearTimeout(this.copyResetTimer);
    this.setState(INITIAL_STATE);
  };

  toggleDetails = () => {
    this.setState((prev) => ({ detailsOpen: !prev.detailsOpen }));
  };

  copyDetails = () => {
    const payload = this.formatReport();
    navigator.clipboard
      .writeText(payload)
      .then(() => {
        this.setState({ copied: true });
        if (this.copyResetTimer !== null) clearTimeout(this.copyResetTimer);
        this.copyResetTimer = setTimeout(() => this.setState({ copied: false }), 1500);
      })
      .catch((err: unknown) => {
        log.warn("clipboard write failed", err);
      });
  };

  reportBug = () => {
    const os = IS_MACOS ? "macOS" : "Linux";
    const params = new URLSearchParams({ os, version: __APP_VERSION__ });
    void import("@tauri-apps/plugin-opener")
      .then((m) => m.openUrl(`https://pikos.app/bugs?${params.toString()}`))
      .catch((err: unknown) => {
        log.warn("openUrl failed", err);
      });
  };

  /** App-controlled error report payload. formatError() runs the same
   *  path-scrubbing the disk logger uses so a copy-and-paste won't leak
   *  the user's home directory into a bug report. */
  formatReport(): string {
    const { componentStack, error } = this.state;
    const lines = [
      `Pikos ${__APP_VERSION__}`,
      `Platform: ${navigator.platform}`,
      "",
      formatError(error),
    ];
    if (componentStack) {
      lines.push("", "Component stack:", componentStack.trim());
    }
    return lines.join("\n");
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    // Caller-supplied compact fallback for pane/dialog boundaries — see PaneErrorFallback.
    if (this.props.fallback && this.state.error) {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }

    const { copied, detailsOpen } = this.state;

    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-foreground">
        <div className="w-full max-w-md">
          <p className="text-lg font-medium">Something went wrong</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Please relaunch the app. If the problem persists, reset and try again.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={this.reset} size="sm" variant="outline">
              Reset
            </Button>
            <Button onClick={this.copyDetails} size="sm" variant="outline">
              <Copy className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy details"}
            </Button>
            <Button onClick={this.reportBug} size="sm" variant="outline">
              <Bug className="h-3.5 w-3.5" />
              Report a bug
            </Button>
          </div>

          <div className="mt-4 rounded-md border border-border bg-card">
            <button
              aria-expanded={detailsOpen}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={this.toggleDetails}
              type="button"
            >
              {detailsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              Error details
            </button>
            {detailsOpen && (
              <pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {this.formatReport()}
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  }
}
