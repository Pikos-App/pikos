import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useRef } from "react";

import {
  createFindPlugin,
  decoratedRange,
  docMatches,
  type FindParams,
  findPluginKey,
  viewportRange,
  WHOLE_DOC,
} from "../utils/findDecorations";

/**
 * Registers Find's plugin and returns what redraws its matches for a query; while Find is open the
 * decorated range follows the scroll.
 */
export function useFindDecorations(
  editor: Editor,
  scroller: RefObject<HTMLElement | null>,
  isOpen: boolean
): (query: string, activeIndex: number) => void {
  const paramsRef = useRef<FindParams>({ activeIndex: 0, query: "", range: WHOLE_DOC });

  useEffect(() => {
    editor.registerPlugin(createFindPlugin(paramsRef));
    return () => {
      editor.unregisterPlugin(findPluginKey);
    };
  }, [editor]);

  useEffect(() => {
    const el = scroller.current;
    if (!isOpen || !el) return;

    let frame = 0;
    const redecorate = () => {
      frame = 0;
      const { query, range } = paramsRef.current;
      if (!query || editor.isDestroyed) return;

      const viewport = viewportRange(editor.view, el);
      if (!viewport) return;

      const isDecorated = viewport.from >= range.from && viewport.to <= range.to;
      if (isDecorated) return;

      paramsRef.current = { ...paramsRef.current, range: decoratedRange(editor.view, el) };
      editor.view.dispatch(editor.state.tr);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(redecorate);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [editor, isOpen, scroller]);

  return (query, activeIndex) => {
    const starts = docMatches(editor.state.doc, query);
    const active = starts.length > 0 ? starts[activeIndex % starts.length] : undefined;
    paramsRef.current = {
      activeIndex,
      query,
      range: decoratedRange(editor.view, scroller.current, active),
    };
    editor.view.dispatch(editor.state.tr);
  };
}
