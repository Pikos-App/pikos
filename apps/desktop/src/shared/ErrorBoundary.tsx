import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null, hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
          <p className="text-lg font-medium">Something went wrong</p>
          <p className="text-sm text-muted-foreground">
            Please relaunch the app. If the problem persists, reset and try again.
          </p>
          <Button onClick={this.reset} variant="outline">
            Reset
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
