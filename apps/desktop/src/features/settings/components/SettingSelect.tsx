import { SettingPicker } from "./SettingPicker";

interface SettingSelectProps<T extends string | number> {
  label: string;
  description: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * A settings row whose choices are too many for `SettingChoice`'s button group.
 * Same row geometry, so the panel still reads as one list.
 */
export function SettingSelect<T extends string | number>({
  description,
  label,
  onChange,
  options,
  value,
}: SettingSelectProps<T>) {
  return (
    <div className="flex items-center justify-between border-b border-border py-ui-lg last:border-b-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingPicker
        label={label}
        listClassName="w-24"
        onChange={onChange}
        options={options}
        value={value}
      />
    </div>
  );
}
