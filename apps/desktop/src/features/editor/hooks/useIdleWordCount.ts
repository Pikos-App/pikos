import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

import { pageStats } from "../utils/pageStats";

/** How long typing pauses before the count catches up. Counting walks the whole page, which at
 *  500,000 words was over half of a keystroke's cost. */
const WORD_COUNT_IDLE_MS = 300;

export function useIdleWordCount(editor: Editor): number {
  const [words, setWords] = useState(() => pageStats(editor.state.doc).words);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function recount(): void {
      setWords(pageStats(editor.state.doc).words);
    }

    function onTransaction({ transaction }: { transaction: Transaction }): void {
      if (!transaction.docChanged) return;

      clearTimeout(timer);
      // How `loadPageContent` marks a load, so a page just opened never shows the last one's count.
      const isPageLoad = transaction.getMeta("addToHistory") === false;
      if (isPageLoad) {
        recount();
        return;
      }

      timer = setTimeout(recount, WORD_COUNT_IDLE_MS);
    }

    editor.on("transaction", onTransaction);

    return () => {
      clearTimeout(timer);
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  return words;
}
