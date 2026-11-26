// Whoever is about to end the process asks here first, and everything holding an unwritten edit
// gets a chance to put it on disk.
//
// Two debounces stack on a page edit: the editor's autosave hands content to the write queue,
// which debounces again before the adapter. Draining is therefore two phases: run the queue
// first and the editor's pending content is still sitting unseen in the editor.
//
// Registration is a set because every producer is idempotent: flushing twice writes nothing.

type Flush = () => void | Promise<void>;

const producers = new Set<Flush>();

const drains = new Set<Flush>();

function register(set: Set<Flush>, fn: Flush): () => void {
  set.add(fn);
  return () => set.delete(fn);
}

export function onFlushPending(fn: Flush): () => void {
  return register(producers, fn);
}

export function onDrainPending(fn: Flush): () => void {
  return register(drains, fn);
}

/** Settle every pending edit. Never rejects, and one flusher never stops the others: a caller is on
 *  its way out of the process. `Promise.resolve().then` makes that true for a *synchronous* throw,
 *  which `allSettled` alone would miss: the exception would escape `map` first. */
async function settleAll(set: Set<Flush>): Promise<void> {
  await Promise.allSettled([...set].map((f) => Promise.resolve().then(f)));
}

export async function flushPendingWrites(): Promise<void> {
  await settleAll(producers);
  await settleAll(drains);
}
