import { PageLink } from "@pikos/editor-schema";
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import { type Ref, useState, useSyncExternalStore } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useUI } from "@/shared/context/UIContext";
import { useViewCacheController } from "@/shared/context/WorkspaceContext";
import { useInlineRename } from "@/shared/hooks/useInlineRename";

import { PageLinkLabelInput } from "../components/PageLinkLabelInput";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_TITLE = () => undefined;

/** The target's current title while the view cache holds it, so a rename shows at once. */
function useHeldTitle(pageId: string): string | undefined {
  const controller = useViewCacheController();
  return useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller ? () => controller.store.get(pageId)?.title : NO_TITLE
  );
}

function PageLinkView({ editor, node, updateAttributes }: ReactNodeViewProps) {
  const pageId = node.attrs["pageId"] as string;
  const storedTitle = node.attrs["title"] as string;
  const label = node.attrs["label"] as string | null;
  const { openPage } = useUI();
  const title = useHeldTitle(pageId) ?? storedTitle;
  const [isEditing, setIsEditing] = useState(false);
  const { contextMenuContentProps, inputRef, prepareRenameFromMenu } = useInlineRename(isEditing);

  function finishEditing() {
    setIsEditing(false);
    editor.commands.focus();
  }

  function commitLabel(text: string) {
    const next = text.trim();
    const isTitle = next === "" || next === title;

    updateAttributes({ label: isTitle ? null : next });
    finishEditing();
  }

  if (isEditing) {
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        <PageLinkLabelInput
          initial={label || title}
          inputRef={inputRef as Ref<HTMLInputElement>}
          onCancel={finishEditing}
          onCommit={commitLabel}
          title={title}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className="page-link"
            contentEditable={false}
            data-page-id={pageId}
            onClick={() => openPage(pageId)}
            title={label ? title || "Untitled" : undefined}
            type="button"
          >
            {label || title || "Untitled"}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent {...contextMenuContentProps}>
          <ContextMenuItem onSelect={() => prepareRenameFromMenu(() => setIsEditing(true))}>
            Edit link text
          </ContextMenuItem>
          {label && (
            <ContextMenuItem onSelect={() => updateAttributes({ label: null })}>
              Show page title
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </NodeViewWrapper>
  );
}

export const DesktopPageLink = PageLink.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView, { as: "span" });
  },
});
