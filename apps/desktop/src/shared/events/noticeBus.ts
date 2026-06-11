// noticeBus — window-event-backed surface for showing a toast from code
// that can't access the UndoDelete React context (Tiptap extensions,
// Tauri drop bridges, module-level handlers). UndoDeleteProvider
// subscribes once and forwards each notice to its own showNotice helper.

const EVENT = "pikos:notice";

interface NoticeDetail {
  label: string;
  durationMs?: number;
}

/** Show a toast notice from anywhere. Safe to call before the React tree mounts — drops silently if no subscriber yet. */
export function postNotice(label: string, durationMs?: number): void {
  if (typeof window === "undefined") return;
  const detail: NoticeDetail = { label, ...(durationMs !== undefined ? { durationMs } : {}) };
  window.dispatchEvent(new CustomEvent<NoticeDetail>(EVENT, { detail }));
}

/** Subscribe a handler (typically UndoDeleteProvider.showNotice). Returns an unsubscribe function. */
export function subscribeNotices(
  handler: (label: string, durationMs?: number) => void
): () => void {
  function onEvent(e: Event) {
    const detail = (e as CustomEvent<NoticeDetail>).detail;
    handler(detail.label, detail.durationMs);
  }
  window.addEventListener(EVENT, onEvent);
  return () => window.removeEventListener(EVENT, onEvent);
}
