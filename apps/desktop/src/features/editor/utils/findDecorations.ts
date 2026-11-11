import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { findDocMatches } from "./textSearch";

export interface PosRange {
  from: number;
  to: number;
}

/**
 * Only matches inside `range` are decorated, plus the active one wherever it is: decorating every
 * match of a common word on a long page took seconds per letter.
 */
export interface FindParams {
  query: string;
  activeIndex: number;
  range: PosRange;
}

export const WHOLE_DOC: PosRange = { from: 0, to: Number.POSITIVE_INFINITY };

/** Positions decorated either side of the viewport, so a short scroll needs no redraw. */
const VIEWPORT_MARGIN = 2_000;

export const findPluginKey = new PluginKey("findContentPopover");

let cached: { doc: PmNode | null; query: string; starts: number[] } = {
  doc: null,
  query: "",
  starts: [],
};

/** Match positions for this document and query, worked out once per change to either. */
export function docMatches(doc: PmNode, query: string): number[] {
  const isCached = cached.doc === doc && cached.query === query;
  if (!isCached) cached = { doc, query, starts: findDocMatches(doc, query) };

  return cached.starts;
}

/** The positions on screen in `scroller`, or null when the editor can't map them. */
export function viewportRange(view: EditorView, scroller: HTMLElement | null): PosRange | null {
  if (!scroller) return null;

  const box = scroller.getBoundingClientRect();
  const content = view.dom.getBoundingClientRect();
  const left = content.left + content.width / 2;
  const top = view.posAtCoords({ left, top: Math.max(box.top, content.top) + 1 });
  const bottom = view.posAtCoords({ left, top: Math.min(box.bottom, content.bottom) - 1 });
  if (!top || !bottom) return null;

  return { from: top.pos, to: bottom.pos };
}

/** The viewport plus a margin, or a viewport's span around `target` when it is off screen. */
export function decoratedRange(
  view: EditorView,
  scroller: HTMLElement | null,
  target?: number
): PosRange {
  const viewport = viewportRange(view, scroller);
  if (!viewport) return WHOLE_DOC;

  const span = viewport.to - viewport.from;
  const isOffScreen = target !== undefined && (target < viewport.from || target > viewport.to);
  const around = isOffScreen ? { from: target - span, to: target + span } : viewport;

  return { from: around.from - VIEWPORT_MARGIN, to: around.to + VIEWPORT_MARGIN };
}

function firstAtOrAfter(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] ?? pos) < pos) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function matchDecoration(from: number, length: number, isActive: boolean): Decoration {
  const cls = isActive ? "find-match find-match-active" : "find-match";
  return Decoration.inline(from, from + length, { class: cls });
}

function buildDecorations(doc: PmNode, { activeIndex, query, range }: FindParams): DecorationSet {
  const starts = docMatches(doc, query);
  if (starts.length === 0) return DecorationSet.empty;

  const active = activeIndex % starts.length;
  const activeStart = starts[active] ?? 0;
  const first = firstAtOrAfter(starts, range.from);
  const decos: Decoration[] = [];
  let last = first;
  for (let start = starts[last]; start !== undefined && start < range.to; start = starts[++last]) {
    decos.push(matchDecoration(start, query.length, last === active));
  }

  if (active < first) decos.unshift(matchDecoration(activeStart, query.length, true));
  else if (active >= last) decos.push(matchDecoration(activeStart, query.length, true));

  return DecorationSet.create(doc, decos);
}

/** Reads `paramsRef` on every redraw; a caller changes it, then dispatches an empty transaction. */
export function createFindPlugin(paramsRef: { readonly current: FindParams }): Plugin {
  return new Plugin({
    key: findPluginKey,
    props: {
      decorations(state) {
        return buildDecorations(state.doc, paramsRef.current);
      },
    },
  });
}
