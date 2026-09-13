// One renderer for every metadata chip row in the app: the editor byline, the
// quick-add footer, and the two calendar block popovers. Each call site keeps
// its own container element and picks the chips, their order, and their
// grouping — this module only owns the scaffolding (byline separators or
// labelled rows) and the shared prop wiring.

import { Fragment, type ReactNode } from "react";

import { BylineSeparator } from "./BylineSeparator";
import { DateTimePicker, type DateTimePickerProps } from "./DateTimePicker";
import { FolderChip, type FolderChipProps } from "./FolderChip";
import { PriorityDropdown, type PriorityDropdownProps } from "./PriorityDropdown";
import { RecurrencePopover, type RecurrencePopoverProps } from "./RecurrencePopover";
import { ReminderDropdown, type ReminderDropdownProps } from "./ReminderDropdown";
import { TagsPopover, type TagsPopoverProps } from "./TagsPopover";
import { TaskCheckbox } from "./TaskCheckbox";

/** Horizontal byline (dot-separated) vs. the popovers' labelled rows. */
export type MetadataChipLayout = "byline" | "rows";

export interface StatusChipProps {
  checked: boolean;
  onToggle: () => void;
}

/**
 * `node` is the escape hatch for the per-site pieces that aren't shared chips:
 * a synced page's read-only schedule label, the editor's own date popover, the
 * "view in calendar" button, the save-failed retry. Its `id` keys the slot, so
 * a chip that comes and goes never shifts its neighbours' identity.
 */
export type MetadataChip =
  | { kind: "date"; props: DateTimePickerProps }
  | { kind: "folder"; props: FolderChipProps }
  | { id: string; kind: "node"; node: ReactNode }
  | { kind: "priority"; props: PriorityDropdownProps }
  | { kind: "recurrence"; props: RecurrencePopoverProps }
  | { kind: "reminder"; props: ReminderDropdownProps }
  | { kind: "status"; props: StatusChipProps }
  | { kind: "tags"; props: TagsPopoverProps };

export interface MetadataChipGroup {
  /** React key, and the row label in the "rows" layout. */
  key: string;
  chips: (MetadataChip | false | null | undefined)[];
  /** Wrap the group's chips in their own flex box rather than emitting them as
   *  direct children of the caller's container. */
  boxed?: boolean;
}

interface PageMetadataChipsProps {
  layout: MetadataChipLayout;
  /** Rendered in order. Falsy entries drop out, taking their separator or
   *  labelled row with them. */
  groups: (MetadataChipGroup | false | null | undefined)[];
}

function StatusChip({
  checked,
  layout,
  onToggle,
}: StatusChipProps & { layout: MetadataChipLayout }) {
  const label = checked ? "Done" : "Open";
  return (
    <button
      aria-label={checked ? "Mark not done" : "Mark done"}
      className={
        layout === "byline"
          ? "group/status inline-flex items-center gap-1.5 rounded transition-colors hover:text-muted-foreground focus:outline-none"
          : "group/status inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
      }
      onClick={onToggle}
    >
      <TaskCheckbox
        as="span"
        checked={checked}
        className={!checked ? "group-hover/status:border-foreground/60" : undefined}
        onChange={onToggle}
      />
      {layout === "byline" ? (
        <span className="inline-block w-[2.5rem]">{label}</span>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}

function chipKey(chip: MetadataChip): string {
  return chip.kind === "node" ? chip.id : chip.kind;
}

function renderChip(chip: MetadataChip, layout: MetadataChipLayout): ReactNode {
  switch (chip.kind) {
    case "date":
      return <DateTimePicker {...chip.props} />;
    case "folder":
      return <FolderChip {...chip.props} />;
    case "node":
      return chip.node;
    case "priority":
      return <PriorityDropdown {...chip.props} />;
    case "recurrence":
      return <RecurrencePopover {...chip.props} />;
    case "reminder":
      return <ReminderDropdown {...chip.props} />;
    case "status":
      return <StatusChip {...chip.props} layout={layout} />;
    case "tags":
      return <TagsPopover {...chip.props} />;
  }
}

export function PageMetadataChips({ groups, layout }: PageMetadataChipsProps) {
  const visible = groups
    .filter((group) => !!group)
    .map((group) => ({ ...group, chips: group.chips.filter((chip) => !!chip) }));

  function renderChips(group: (typeof visible)[number]): ReactNode {
    const chips = group.chips.map((chip) => (
      <Fragment key={chipKey(chip)}>{renderChip(chip, layout)}</Fragment>
    ));
    if (!group.boxed) return chips;
    return (
      <div
        className={
          layout === "byline"
            ? "inline-flex shrink-0 items-center gap-2"
            : "flex items-center gap-2"
        }
      >
        {chips}
      </div>
    );
  }

  if (layout === "rows") {
    return (
      <>
        {visible.map((group) => (
          <div className="flex items-center gap-3" key={group.key}>
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">{group.key}</span>
            {renderChips(group)}
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      {visible.map((group, groupIndex) => (
        <Fragment key={group.key}>
          {groupIndex > 0 && <BylineSeparator />}
          {renderChips(group)}
        </Fragment>
      ))}
    </>
  );
}
