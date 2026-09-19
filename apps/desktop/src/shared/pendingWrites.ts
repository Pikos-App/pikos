// Whoever is about to end the process asks here first, and everything holding an
// unwritten edit gets a chance to put it on disk.
//
// Two debounces stack on a single page edit: the editor's own autosave (800ms)
// hands content to the write queue, which debounces again (800ms) before it
// reaches the adapter. So draining is two phases, not one — run the queue first
// and the editor's pending content is still sitting in the editor, unseen.
//
// Registration is a set rather than a list because every producer is idempotent:
// flushing twice writes nothing the second time.

type Flush = () => void | Promise<void>;

/** Holds an edit that has not reached the write queue yet. Runs first. */
const producers = new Set<Flush>();

/** Owns the write queue itself. Runs after every producer has fed it. */
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

/** Settle every pending edit. Never rejects, and never lets one flusher stop the
 *  others: a caller is on its way out of the process, so the rest of the work is
 *  the only thing left to protect. `Promise.resolve().then` is what makes that
 *  true for a *synchronous* throw, which `allSettled` alone would not catch —
 *  the exception would escape `map` before `allSettled` ever saw the array. */
async function settleAll(set: Set<Flush>): Promise<void> {
  await Promise.allSettled([...set].map((f) => Promise.resolve().then(f)));
}

export async function flushPendingWrites(): Promise<void> {
  await settleAll(producers);
  await settleAll(drains);
}
