import { useState } from "react";
import {
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useUI } from "@/shared/context/UIContext";
import { getVisiblePages, sortPages } from "@/features/pages/utils/pageFilters";
import type { Folder, Page } from "@pikos/core";

export function useThreePanelDnD() {
  const { pages, folders, reorderPages, reorderFolders, updatePage } = useWorkspace();
  const { activeViewId, getSortMode } = useUI();

  const [activePageData, setActivePageData] = useState<Page | null>(null);
  const [activeFolderData, setActiveFolderData] = useState<Folder | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function handleDragStart({ active }: DragStartEvent) {
    const type = active.data.current?.type as string | undefined;
    if (type === "page") {
      setActivePageData(pages.find((p) => p.id === active.id) ?? null);
    } else if (type === "folder") {
      setActiveFolderData(folders.find((f) => f.id === active.id) ?? null);
    }
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActivePageData(null);
    setActiveFolderData(null);
    if (!over || active.id === over.id) return;

    const at = active.data.current?.type as string | undefined;
    const ot = over.data.current?.type as string | undefined;

    if (at === "page" && ot === "page") {
      // Only reorder in manual sort mode — other modes lock DnD.
      if (activeViewId === "today") return;
      const currentSortMode = getSortMode(activeViewId);
      if (currentSortMode !== "manual") return;
      const visible = sortPages(getVisiblePages(pages, activeViewId), currentSortMode);
      const oldIdx = visible.findIndex((p) => p.id === active.id);
      const newIdx = visible.findIndex((p) => p.id === over.id);
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
      const folderId = activeViewId !== "today" && activeViewId !== "inbox" ? activeViewId : null;
      void reorderPages(
        folderId,
        arrayMove(visible, oldIdx, newIdx).map((p) => p.id)
      );
    } else if (at === "page" && ot === "folder") {
      // folderId stored in droppable data; null means Inbox.
      const folderId = (over.data.current?.folderId as string | null | undefined) ?? null;
      updatePage(String(active.id), { folderId });
    } else if (at === "folder" && ot === "folder") {
      const oldIdx = folders.findIndex((f) => f.id === active.id);
      const newIdx = folders.findIndex((f) => f.id === over.id);
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
      void reorderFolders(arrayMove(folders, oldIdx, newIdx).map((f) => f.id));
    }
  }

  function handleDragCancel() {
    setActivePageData(null);
    setActiveFolderData(null);
  }

  return {
    sensors,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
    activePageData,
    activeFolderData,
  };
}
