import { storageErrorUserMessage, toStorageError } from "@pikos/core";
import { AlertTriangle } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePages } from "@/shared/context/PagesContext";

interface SaveStatusProps {
  pageId: string;
  contentSaveError: Error | null;
  isSaving: boolean;
  onRetryContent: () => void;
}

/**
 * The editor's one save status, in the corner beside the word count rather than
 * in the byline: a failed save is a state of the app, not a property of the page,
 * and a chip joining a flow row shifts everything after it.
 *
 * "Saving…" is announced but never drawn. A save resolves within the same pause
 * in typing, so a visible one would flash on every autosave.
 */
export function SaveStatus({
  contentSaveError,
  isSaving,
  onRetryContent,
  pageId,
}: SaveStatusProps) {
  const { clearPageError, pageErrors } = usePages();

  const metadataError = pageErrors.get(pageId) ?? null;
  // Friendly per-kind copy from @pikos/core — never echoes raw sqlx/Tauri text.
  const errorMessage = metadataError
    ? storageErrorUserMessage(metadataError, "saving page metadata")
    : contentSaveError
      ? storageErrorUserMessage(toStorageError(contentSaveError), "saving page content")
      : null;

  function handleRetry() {
    clearPageError(pageId);
    onRetryContent();
  }

  return (
    <>
      <div aria-atomic="true" aria-live="assertive" className="sr-only">
        {errorMessage ? "Failed to save. Please try again." : isSaving ? "Saving…" : ""}
      </div>
      {errorMessage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="Save failed. Click to retry"
              className="type-ui-sm inline-flex items-center gap-1 rounded-md px-2 py-1 text-amber-500/70 transition-colors hover:text-amber-500 focus:outline-none"
              onClick={handleRetry}
            >
              <AlertTriangle size={12} strokeWidth={2} />
              <span>Not saved</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px]" side="top">
            {errorMessage}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
