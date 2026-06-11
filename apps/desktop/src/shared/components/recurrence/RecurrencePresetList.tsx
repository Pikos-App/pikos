import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Preset } from "./recurrenceConstants";

export interface RecurrencePresetListProps {
  presets: Preset[];
  activePresetId: string | null;
  isCustomShape: boolean;
  customVisible: boolean;
  onSelectPreset: (preset: Preset) => void;
  onToggleCustom: () => void;
}

export function RecurrencePresetList({
  activePresetId,
  customVisible,
  isCustomShape,
  onSelectPreset,
  onToggleCustom,
  presets,
}: RecurrencePresetListProps) {
  if (presets.length === 0) return null;

  return (
    <div className="flex flex-col py-1">
      {presets.map((preset) => {
        const isActive = activePresetId === preset.id;
        return (
          <div key={preset.id}>
            {preset.startsGroup && <div className="my-1 border-t border-border/40" />}
            <button
              aria-pressed={isActive}
              className={cn(
                "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors",
                isActive
                  ? "text-primary"
                  : "text-foreground/80 hover:bg-accent hover:text-foreground"
              )}
              onClick={() => onSelectPreset(preset)}
              type="button"
            >
              <span className="flex items-baseline gap-1.5">
                <span>{preset.label}</span>
                {preset.detail && (
                  <span
                    className={cn(
                      "text-xs",
                      isActive ? "text-primary/60" : "text-muted-foreground/60"
                    )}
                  >
                    {preset.detail}
                  </span>
                )}
              </span>
              {isActive && <Check aria-hidden="true" size={12} strokeWidth={2.5} />}
            </button>
          </div>
        );
      })}

      <div className="my-1 border-t border-border/40" />
      <button
        aria-expanded={customVisible}
        className={cn(
          "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors",
          isCustomShape
            ? "text-primary"
            : "text-foreground/70 hover:bg-accent hover:text-foreground"
        )}
        onClick={onToggleCustom}
        type="button"
      >
        <span>Custom…</span>
        {isCustomShape ? (
          <Check aria-hidden="true" size={12} strokeWidth={2.5} />
        ) : (
          <ChevronDown
            aria-hidden="true"
            className={cn("transition-transform", customVisible && "rotate-180")}
            size={12}
          />
        )}
      </button>
    </div>
  );
}
