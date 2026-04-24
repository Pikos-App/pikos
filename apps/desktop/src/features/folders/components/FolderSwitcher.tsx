// FolderSwitcher — popover-driven view picker used when the folder sidebar is
// hidden at md/sm breakpoints. Lists smart views (Today, Inbox) + folders and
// calls setActiveViewId on selection. Not rendered at xl/lg where the sidebar
// is already visible.

import { CalendarDays, ChevronDown, FolderPlus, Inbox } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { useFolderList } from "../hooks/useFolderList";

export function FolderSwitcher() {
  const { activeViewId, folders, inboxCount, pageCountByFolder, setActiveViewId, todayCount } =
    useFolderList();
  const { createFolder } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const activeFolder = folders.find((f) => f.id === activeViewId);
  const activeLabel =
    activeViewId === "today"
      ? "Today"
      : activeViewId === "inbox"
        ? "Inbox"
        : (activeFolder?.name ?? "Pages");

  function handleSelect(id: string) {
    setActiveViewId(id);
    setOpen(false);
  }

  function resetCreate() {
    setCreating(false);
    setNewName("");
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) resetCreate();
  }

  async function commitNewFolder() {
    const name = newName.trim();
    if (!name) {
      resetCreate();
      return;
    }
    const folder = await createFolder({ name });
    setActiveViewId(folder.id);
    resetCreate();
    setOpen(false);
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="Switch view"
          className="type-ui flex max-w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-foreground transition-[background-color] duration-[var(--transition-fast)] hover:bg-surface-hover"
        >
          <span className="min-w-0 truncate">{activeLabel}</span>
          <ChevronDown className="shrink-0 text-text-tertiary" size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1" sideOffset={6}>
        <Row
          badge={todayCount}
          icon={<CalendarDays size={14} />}
          isActive={activeViewId === "today"}
          label="Today"
          onSelect={() => handleSelect("today")}
        />
        <Row
          badge={inboxCount}
          icon={<Inbox size={14} />}
          isActive={activeViewId === "inbox"}
          label="Inbox"
          onSelect={() => handleSelect("inbox")}
        />
        {folders.length > 0 && <div className="my-1 border-t border-border/50" role="separator" />}
        {folders.map((folder) => (
          <Row
            badge={pageCountByFolder[folder.id] ?? 0}
            dot={folder.color ?? undefined}
            isActive={activeViewId === folder.id}
            key={folder.id}
            label={folder.name || "Untitled"}
            onSelect={() => handleSelect(folder.id)}
          />
        ))}
        <div className="my-1 border-t border-border/50" role="separator" />
        {creating ? (
          <div className="px-2 py-1.5">
            <input
              autoFocus
              className="type-ui-sm w-full rounded border border-border bg-background px-2 py-1 text-foreground placeholder:text-text-tertiary focus-visible:border-ring focus-visible:outline-none"
              onBlur={() => void commitNewFolder()}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitNewFolder();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  resetCreate();
                }
              }}
              placeholder="Folder name"
              value={newName}
            />
          </div>
        ) : (
          <Row
            icon={<FolderPlus size={14} />}
            isActive={false}
            label="New folder"
            onSelect={() => setCreating(true)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

interface RowProps {
  badge?: number;
  dot?: string | undefined;
  icon?: React.ReactNode;
  isActive: boolean;
  label: string;
  onSelect: () => void;
}

function Row({ badge, dot, icon, isActive, label, onSelect }: RowProps) {
  return (
    <button
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "type-ui-sm flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-[background-color,color] duration-[var(--transition-fast)]",
        isActive
          ? "bg-surface-nav-selected text-foreground"
          : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
      )}
      onClick={onSelect}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {dot !== undefined && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dot || "hsl(var(--muted-foreground) / 0.4)" }}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="type-ui-sm text-subtle tabular-nums">{badge > 99 ? "99+" : badge}</span>
      )}
    </button>
  );
}
