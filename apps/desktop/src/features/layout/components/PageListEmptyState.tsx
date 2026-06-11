import { FilePlus, Inbox, Sun } from "lucide-react";

import { EmptyState } from "@/shared/components/EmptyState";
import { MOD_KEY_LABEL } from "@/shared/constants/platform";

interface PageListEmptyStateProps {
  activeViewId: string;
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

export function PageListEmptyState({ activeViewId }: PageListEmptyStateProps) {
  if (activeViewId === "today") {
    return (
      <div className="border-b border-border">
        <EmptyState icon={Sun} message="Nothing scheduled for today">
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
