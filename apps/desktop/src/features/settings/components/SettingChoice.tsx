import { cn } from "@/lib/utils";

interface SettingChoiceProps<T extends string | number> {
  label: string;
  description: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

export function SettingChoice<T extends string | number>({
  description,
  label,
  onChange,
  options,
  value,
}: SettingChoiceProps<T>) {
  return (
    <div className="flex items-center justify-between border-b border-border py-3 last:border-b-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 gap-1 rounded-md border border-border bg-background p-0.5">
        {options.map((opt) => (
          <button
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
              value === opt.id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            key={String(opt.id)}
            onClick={() => onChange(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
