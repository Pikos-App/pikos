import { createDocument, type Editor, type JSONContent } from "@tiptap/core";
import { Fragment, type Node } from "@tiptap/pm/model";

/** Document positions drawn before a page is shown, about 1,300 words: more than a tall window
 *  holds at the smallest text size, so the rest arriving is never on screen. Measured in text rather
 *  than blocks because a prose block holds ten times a log line. */
export const FIRST_SCREEN_SIZE = 8_000;

/** Document positions drawn per slice after the first screen, about a frame's work. */
const SLICE_SIZE = 40_000;

/** Marks a transaction that draws a slice of the page being opened, which is a load, not an edit. */
export const REST_OF_PAGE_META = "pikosRestOfPage";

/**
 * Put a page's content into the editor.
 *
 * Two flags, both load-bearing:
 *
 * - `emitUpdate: false` stops the load being reported as a change, which would
 *   trigger autosave for content the user has not touched.
 * - `addToHistory: false` keeps the load out of the undo stack. Without it the
 *   load is an undoable step, so undo on a freshly-opened page reverts to the
 *   empty document the editor was constructed with — and because onUpdate then
 *   fires, autosave persists that empty document. Typing within ProseMirror's
 *   ~500ms grouping window has the same effect, as the keystroke is grouped
 *   with the load and one undo reverts both.
 */
export function loadPageContent(editor: Editor, doc: JSONContent | Node): void {
  editor.chain().setMeta("addToHistory", false).setContent(doc, { emitUpdate: false }).run();
}

/** Where a run of blocks from `start` reaches `size`, taking at least one block. */
function blocksWithin(blocks: readonly Node[], start: number, size: number): number {
  let end = start;
  let taken = 0;
  while (end < blocks.length && (end === start || taken < size)) {
    taken += blocks[end]?.nodeSize ?? 0;
    end += 1;
  }

  return end;
}

/** The blocks of a long page not drawn yet. */
export interface RestOfPage {
  /** Draw everything left, now. */
  finish(): void;
  /** Draw nothing more, because another body is replacing this one. */
  cancel(): void;
}

/**
 * Open a page with its first screen drawn now and the rest in slices on the tasks after, or in one
 * go when it fits. Building the DOM is nearly all of what opening a long page costs, so this moves
 * when it is paid rather than how much.
 *
 * Each slice is appended at the end of the document, which is only where it belongs while nothing
 * has been typed past the first screen. The caller therefore calls `finish` before any input, edit,
 * or jump to the end reaches the editor; a save then never sees part of the page. The whole body is
 * parsed up front, so a block the schema rejects empties the page as `setContent` would, rather than
 * leaving the slices before it.
 *
 * The editor's DOM carries `aria-busy` until the last slice is drawn.
 */
export function openPageContent(editor: Editor, doc: JSONContent): RestOfPage | null {
  const full = createDocument(doc, editor.schema);

  const blocks: Node[] = [];
  full.forEach((block) => blocks.push(block));
  const firstScreen = blocksWithin(blocks, 0, FIRST_SCREEN_SIZE);

  const isLong = firstScreen < blocks.length;
  if (!isLong) {
    loadPageContent(editor, full);
    return null;
  }

  loadPageContent(editor, full.copy(Fragment.fromArray(blocks.slice(0, firstScreen))));

  const dom = editor.view.dom;
  dom.setAttribute("aria-busy", "true");
  let drawn = firstScreen;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A slice queued straight away runs before the first frame and delays the first screen.
  const afterFirstPaint = requestAnimationFrame(() => {
    timer = setTimeout(drawSlice);
  });

  function drawUpTo(end: number): void {
    const tr = editor.state.tr
      .insert(editor.state.doc.content.size, blocks.slice(drawn, end))
      .setMeta("addToHistory", false)
      .setMeta("preventUpdate", true)
      .setMeta(REST_OF_PAGE_META, true);
    drawn = end;
    editor.view.dispatch(tr);
  }

  function stop(): void {
    cancelAnimationFrame(afterFirstPaint);
    clearTimeout(timer);
    dom.removeAttribute("aria-busy");
  }

  function drawSlice(): void {
    if (editor.isDestroyed) return;

    drawUpTo(blocksWithin(blocks, drawn, SLICE_SIZE));

    const isDone = drawn === blocks.length;
    if (isDone) stop();
    else timer = setTimeout(drawSlice);
  }

  return {
    cancel: stop,
    finish() {
      const hasRest = drawn < blocks.length && !editor.isDestroyed;
      if (hasRest) drawUpTo(blocks.length);

      stop();
    },
  };
}
