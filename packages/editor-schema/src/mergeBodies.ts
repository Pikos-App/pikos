import { type Editor, getSchema } from "@tiptap/core";
import { Node, type Schema } from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";

import { createDocumentExtensions } from "./index";

let schema: Schema | undefined;

function documentSchema(): Schema {
  schema ??= getSchema(createDocumentExtensions({ resolveAssetUrl: (path) => path }));
  return schema;
}

/** The one range `from` and `to` differ in, as a step that turns one into the other. */
function changedRange(from: Node, to: Node): ReplaceStep | null {
  const start = from.content.findDiffStart(to.content);
  if (start === null) return null;

  const end = from.content.findDiffEnd(to.content);
  if (!end) return null;

  // A repeated run either side of the change lets the end scan walk back past the start.
  const overlap = start - Math.min(end.a, end.b);
  const endA = end.a + Math.max(overlap, 0);
  const endB = end.b + Math.max(overlap, 0);
  const step = new ReplaceStep(start, endA, to.slice(start, endB));
  const isFaithful = step.apply(from).doc?.eq(to) ?? false;

  return isFaithful ? step : null;
}

/**
 * A page body's save, refused because another device's edit moved the stored body on since `base`
 * was loaded, merged onto that edit. Each side's change is reduced to the one range it touched, and
 * the local change is moved through the remote one, as ProseMirror's collaboration module rebases a
 * step. Returns null when both touched the same stretch, and the caller keeps its own version.
 *
 * A single range per side rather than a full diff: a save carries under a second of typing, which
 * is almost always one place, and a remote edit inside a wider local range is reported as a
 * conflict rather than overwritten.
 */
export function mergeBodies(base: Node, local: Node, remote: Node): Node | null {
  if (local.eq(remote)) return local;

  const mine = changedRange(base, local);
  if (!mine) return local.eq(base) ? remote : null;

  const theirs = changedRange(base, remote);
  if (!theirs) return remote.eq(base) ? local : null;

  const isOverlapping = mine.from < theirs.to && theirs.from < mine.to;
  if (isOverlapping) return null;

  return mine.map(theirs.getMap())?.apply(remote).doc ?? null;
}

/**
 * Brings `stored`, a body saved over `base`, into an editor that held `base` then, keeping what was
 * typed since. One step kept out of the undo history, so the caret and the undo stack map through
 * it. False when that typing touched the same words, and the editor keeps its own version.
 */
export function foldBodyJSON(editor: Editor, base: string, stored: string): boolean {
  try {
    const parse = (json: string) => Node.fromJSON(editor.schema, JSON.parse(json));
    const current = editor.state.doc;
    const merged = mergeBodies(parse(base), current, parse(stored));
    if (!merged) return false;

    const step = changedRange(current, merged);
    if (step) editor.view.dispatch(editor.state.tr.step(step).setMeta("addToHistory", false));
    return true;
  } catch {
    return false;
  }
}

/** [`mergeBodies`] over stored documents, for a caller holding JSON rather than an editor. */
export function mergeBodyJSON(base: string, local: string, remote: string): string | null {
  try {
    const parse = (json: string) => Node.fromJSON(documentSchema(), JSON.parse(json));
    const merged = mergeBodies(parse(base), parse(local), parse(remote));

    return merged ? JSON.stringify(merged.toJSON()) : null;
  } catch {
    return null;
  }
}
