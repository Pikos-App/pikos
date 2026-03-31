// EditorSettings — spell check toggle + line width picker.

import { cn } from "@/lib/utils";
import type { LineWidth } from "@/shared/context/EditorSettingsContext";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";

const LINE_WIDTH_OPTIONS: { id: LineWidth; label: string; description: string }[] = [
  { description: "~60 characters per line.", id: "narrow", label: "Narrow" },
  { description: "~72 characters per line.", id: "default", label: "Default" },
  { description: "~88 characters per line.", id: "wide", label: "Wide" },
  { description: "Fill the available width.", id: "full", label: "Full" },
];

export function EditorSettings() {
  const { lineWidth, setLineWidth, setSpellCheck, spellCheck } = useEditorSettings();

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold">Editor</h2>
      <p className="mb-6 text-sm text-muted-foreground">Configure the writing experience.</p>

      {/* ── Spell check ─────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h3 className="mb-3 text-sm font-medium">Spell check</h3>
        <div className="rounded-lg border border-border bg-card">
          <button
            className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50"
            onClick={() => setSpellCheck(!spellCheck)}
          >
            <div>
              <p className="text-sm font-medium">Enable spell check</p>
              <p className="text-xs text-muted-foreground">
                Underline misspelled words in the editor.
              </p>
            </div>
            {/* Toggle indicator */}
            <div
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                spellCheck ? "bg-primary" : "bg-muted-foreground/30"
              )}
            >
              <div
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                  spellCheck ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </div>
          </button>
        </div>
      </section>

      {/* ── Line width ──────────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-3 text-sm font-medium">Line width</h3>
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {LINE_WIDTH_OPTIONS.map((opt) => (
            <button
              className={cn(
                "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50",
                lineWidth === opt.id && "bg-accent/40"
              )}
              key={opt.id}
              onClick={() => setLineWidth(opt.id)}
            >
              <div>
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.description}</p>
              </div>
              <div
                className={cn(
                  "h-4 w-4 shrink-0 rounded-full border-2 transition-colors",
                  lineWidth === opt.id
                    ? "border-primary bg-primary"
                    : "border-muted-foreground/40 bg-transparent"
                )}
              />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
