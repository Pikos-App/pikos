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
          ? "group/status inline-flex items-center gap-ui-sm rounded transition-colors hover:text-muted-foreground focus:outline-none"
          : "group/status inline-flex items-center gap-ui-sm rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
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
        // Scales with the interface, like every size token: a `rem` is relative to the
        // root, which the text scale does not touch, so at 200% the label outgrew its box
        // and ran into the chip beside it.
        <span className="inline-block w-[calc(2.5rem*var(--ui-text-scale,1))]">{label}</span>
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
            ? "inline-flex shrink-0 items-center gap-ui-md"
            : "flex items-center gap-ui-md"
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
            {/* The label column scales with the interface. Fixed at `w-14` the label
                outgrew its own box at a large text size and ran into the value beside
                it, so the row read as one word. */}
            <span className="type-ui-sm w-[calc(3.5rem*var(--ui-text-scale,1))] shrink-0 text-muted-foreground/50">
              {group.key}
            </span>
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
