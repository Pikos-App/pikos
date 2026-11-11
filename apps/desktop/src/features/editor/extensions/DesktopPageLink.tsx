import { PageLink } from "@pikos/editor-schema";
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import { useSyncExternalStore } from "react";

import { useUI } from "@/shared/context/UIContext";
import { useViewCacheController } from "@/shared/context/WorkspaceContext";

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

function PageLinkView({ node }: ReactNodeViewProps) {
  const pageId = node.attrs["pageId"] as string;
  const storedTitle = node.attrs["title"] as string;
  const { openPage } = useUI();
  const title = useHeldTitle(pageId) ?? storedTitle;

  return (
    <NodeViewWrapper as="span">
      <button
        className="page-link"
        contentEditable={false}
        data-page-id={pageId}
        onClick={() => openPage(pageId)}
        type="button"
      >
        {title || "Untitled"}
      </button>
    </NodeViewWrapper>
  );
}

export const DesktopPageLink = PageLink.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView, { as: "span" });
  },
});
