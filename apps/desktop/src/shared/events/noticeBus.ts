// For toasts from code that can't reach the UndoDelete React context (Tiptap extensions, Tauri
// drop bridges). UndoDeleteProvider subscribes once and forwards each notice.

const EVENT = "pikos:notice";

interface NoticeDetail {
  label: string;
  durationMs?: number;
}

export function postNotice(label: string, durationMs?: number): void {
  if (typeof window === "undefined") return;
  const detail: NoticeDetail = { label, ...(durationMs !== undefined ? { durationMs } : {}) };
  window.dispatchEvent(new CustomEvent<NoticeDetail>(EVENT, { detail }));
}

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
