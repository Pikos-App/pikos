const BASE_SAVE_DELAY_MS = 800;

/** The longest typing can sit unsaved on a crash. Cmd+Q, a page switch and leaving the window
 *  flush regardless. */
const MAX_SAVE_DELAY_MS = 5000;

/** A save writes the whole body and re-indexes all of its text, so its cost grows with the page,
 *  not with the edit. This rate leaves pages under about 70,000 words on the base delay and
 *  reaches the cap near 400,000. */
const DOC_POSITIONS_PER_MS = 500;

/** How long typing pauses before the body is saved, for a document of this ProseMirror size. */
export function saveDelayFor(docSize: number): number {
  const scaled = docSize / DOC_POSITIONS_PER_MS;

  return Math.round(Math.min(MAX_SAVE_DELAY_MS, Math.max(BASE_SAVE_DELAY_MS, scaled)));
}
