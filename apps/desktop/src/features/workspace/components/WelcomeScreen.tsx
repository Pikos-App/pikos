import { useWorkspace } from "@/shared/context/WorkspaceContext";

export function WelcomeScreen() {
  const ctx = useWorkspace();

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Pikos</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Notes, tasks, and calendar — all in one place, local-first.
        </p>
        <button
          className="rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={ctx.isLoading}
          onClick={() => void ctx.selectWorkspace()}
        >
          {ctx.isLoading ? "Setting up…" : "Get started"}
        </button>
      </div>
    </div>
  );
}
