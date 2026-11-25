import { useEffect, useRef } from "react";

function sitsOnOneLine(a: Element, b: Element): boolean {
  const first = a.getBoundingClientRect();
  const second = b.getBoundingClientRect();

  return first.top < second.bottom && second.top < first.bottom;
}

/**
 * Dot between metadata chips in a byline row. A row that wraps would leave a dot
 * ending one line or starting the next, separating nothing, so a dot hides unless
 * both neighbours share its line. Hidden rather than removed, so hiding it can't
 * move a chip back onto the line above and flip the answer.
 */
export function BylineSeparator() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const dot = ref.current;
    const row = dot?.parentElement;
    if (!dot || !row) return;

    const observer = new ResizeObserver(() => {
      const prev = dot.previousElementSibling;
      const next = dot.nextElementSibling;
      const separatesTwoChips =
        !!prev && !!next && sitsOnOneLine(prev, dot) && sitsOnOneLine(dot, next);

      dot.style.visibility = separatesTwoChips ? "" : "hidden";
    });
    // The chips too: one growing can push the next onto a line that already exists,
    // which moves nothing the row's own size would report.
    observer.observe(row);
    for (const chip of row.children) observer.observe(chip);

    return () => observer.disconnect();
  }, []);

  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/20" ref={ref}>
      ·
    </span>
  );
}
