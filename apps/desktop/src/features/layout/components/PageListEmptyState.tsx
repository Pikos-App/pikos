import { CalendarRange, CalendarSync, FilePlus, Inbox, Sun } from "lucide-react";

import { EmptyState } from "@/shared/components/EmptyState";
import { MOD_KEY_LABEL } from "@/shared/constants/platform";

interface PageListEmptyStateProps {
  activeViewId: string;
  /** True when the active folder is a synced external calendar (read-only mirror). */
  isExternalCalendar?: boolean;
}

function CmdNHint() {
  return (
    <p className="type-ui-sm mt-1 text-subtle">
      Press{" "}
      <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">{MOD_KEY_LABEL}N</kbd>{" "}
      to create a new page
    </p>
  );
}

export function PageListEmptyState({ activeViewId, isExternalCalendar }: PageListEmptyStateProps) {
  // Synced folders are read-only mirrors — no new-page affordance, and "empty"
  // means nothing has synced into the visible range yet, not "go create one".
  if (isExternalCalendar) {
    return (
      <div className="border-b border-border">
        <EmptyState icon={CalendarSync} message="No synced events here yet">
          <p className="type-ui-sm mt-1 text-subtle">
            Events from this calendar will appear automatically.
          </p>
        </EmptyState>
      </div>
    );
  }
  if (activeViewId === "today") {
    return (
      <div className="border-b border-border">
        <EmptyState icon={Sun} message="Nothing scheduled for today">
          <CmdNHint />
        </EmptyState>
      </div>
    );
  }
  if (activeViewId === "upcoming") {
    return (
      <div className="border-b border-border">
        <EmptyState icon={CalendarRange} message="Nothing scheduled in the next 7 days">
          <CmdNHint />
        </EmptyState>
      </div>
    );
  }
  if (activeViewId === "inbox") {
    return (
      <div className="border-b border-border">
        <EmptyState icon={Inbox} message="No pages in your inbox">
          <CmdNHint />
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="border-b border-border">
      <EmptyState icon={FilePlus} message="No pages in this folder">
        <CmdNHint />
      </EmptyState>
    </div>
  );
}
