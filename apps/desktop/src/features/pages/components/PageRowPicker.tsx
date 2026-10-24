import type { PageSummary } from "@pikos/core";

import type { AnchoredOpen } from "@/shared/components/PickerTrigger";
import { RecurrencePopover } from "@/shared/components/RecurrencePopover";
import { ScheduleDateButton } from "@/shared/components/ScheduleDateButton";
import { TagsPopover } from "@/shared/components/TagsPopover";
import { usePages } from "@/shared/context/PagesContext";
import { usePageMetadataWrites } from "@/shared/hooks/usePageMetadataWrites";

import type { OpenRowPicker } from "../hooks/useRowPicker";

/** The byline's date, tags or repeat picker, opened beside a list row from its menu. */
export function PageRowPicker({
  onClose,
  page,
  picker,
}: {
  page: PageSummary;
  picker: OpenRowPicker;
  onClose: () => void;
}) {
  const { recurrenceRules, tags } = usePages();
  const { changeRecurrence, toggleTag } = usePageMetadataWrites();
  const anchored: AnchoredOpen = { anchor: picker.anchor, onClose };

  switch (picker.kind) {
    case "pick-date":
      return <ScheduleDateButton anchored={anchored} page={page} />;
    case "tags":
      return (
        <TagsPopover
          allTags={tags.map((t) => t.name)}
          anchored={anchored}
          onToggle={(name) => toggleTag(page, name)}
          selected={page.tags}
        />
      );
    case "repeat":
      return (
        <RecurrencePopover
          anchorDate={page.scheduledStart ?? null}
          anchored={anchored}
          onChange={(rrule) => void changeRecurrence(page, rrule)}
          rrule={recurrenceRules.find((r) => r.pageId === page.id)?.rrule ?? null}
        />
      );
  }
}
