import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CalendarDays, Inbox, Plus } from "lucide-react";
import { FolderItem } from "./components/FolderItem";
import { FolderDeleteDialog } from "./components/FolderDeleteDialog";
import { SmartViewEntry } from "./components/SmartViewEntry";
import { useFolderList } from "./hooks/useFolderList";

export function FolderList() {
  const {
    folders,
    activeViewId,
    setActiveViewId,
    renamingId,
    setRenamingId,
    pendingDelete,
    handleCreateFolder,
    handleDragEnd,
    handleRenameCommit,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleColorChange,
  } = useFolderList();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  return (
    <>
      <div className="flex flex-col gap-0.5 px-1 py-2">
        <SmartViewEntry
          label="Today"
          icon={<CalendarDays size={14} />}
          isActive={activeViewId === "today"}
          onSelect={() => setActiveViewId("today")}
        />
        <SmartViewEntry
          label="Inbox"
          icon={<Inbox size={14} />}
          isActive={activeViewId === "inbox"}
          onSelect={() => setActiveViewId("inbox")}
        />

        <div className="mt-3 mb-0.5 flex items-center justify-between pr-1 pl-2">
          <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            Folders
          </span>
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="New Folder"
            onClick={() => void handleCreateFolder()}
          >
            <Plus size={12} />
          </button>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={folders.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {folders.map((folder) => (
              <FolderItem
                key={folder.id}
                folder={folder}
                isActive={activeViewId === folder.id}
                isRenaming={renamingId === folder.id}
                onSelect={() => setActiveViewId(folder.id)}
                onRenameStart={() => setRenamingId(folder.id)}
                onRenameCommit={(name) => handleRenameCommit(folder.id, name)}
                onRenameCancel={() => setRenamingId(null)}
                onDelete={() => handleDeleteRequest(folder)}
                onColorChange={(color) => handleColorChange(folder.id, color)}
              />
            ))}
          </SortableContext>
        </DndContext>

        {folders.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground italic">No folders yet</p>
        )}
      </div>

      {pendingDelete && (
        <FolderDeleteDialog
          folderName={pendingDelete.folder.name}
          pageCount={pendingDelete.pageCount}
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
        />
      )}
    </>
  );
}
