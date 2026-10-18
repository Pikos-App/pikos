import type { QuickAddHighlightKind, QuickAddHighlightToken } from "@pikos/core";
import { useRef, useState } from "react";
import type React from "react";

import { cn } from "@/lib/utils";

const KIND_CLASS: Record<Exclude<QuickAddHighlightKind, "priority">, string> = {
  folder: "text-subtle",
  note: "text-subtle",
  tag: "text-subtle",
  when: "text-action",
};

interface QuickAddInputProps extends React.ComponentProps<"input"> {
  /** The colour of the priority the line parses to, which a `!` word takes. */
  priorityClass: string;
  tokens: QuickAddHighlightToken[];
  value: string;
}

/**
 * The quick-add field, with the words the parser read coloured where they were typed.
 *
 * An `<input>` can't colour part of its value, so a backdrop draws the same text in spans and the
 * input's own text is transparent over it, keeping its caret and selection. Font, padding and
 * horizontal scroll must match exactly or the colours slide off their words. While an IME is
 * composing, the backdrop steps aside and the input draws its own text, so the composition
 * underline and candidate text stay visible.
 */
export function QuickAddInput({
  className,
  onCompositionEnd,
  onCompositionStart,
  onScroll,
  priorityClass,
  tokens,
  value,
  ...inputProps
}: QuickAddInputProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [isComposing, setIsComposing] = useState(false);
  const showsBackdrop = !isComposing && tokens.length > 0;

  return (
    <div className="relative">
      {showsBackdrop && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-base whitespace-pre text-foreground"
          ref={(node) => {
            backdropRef.current = node;
            const input = node?.nextElementSibling;
            if (node && input instanceof HTMLInputElement) node.scrollLeft = input.scrollLeft;
          }}
        >
          <span>{segments(value, tokens, priorityClass)}</span>
        </div>
      )}
      <input
        {...inputProps}
        className={cn(
          "relative w-full bg-transparent text-base text-foreground caret-foreground outline-none",
          showsBackdrop && "text-transparent",
          className
        )}
        onCompositionEnd={(event) => {
          setIsComposing(false);
          onCompositionEnd?.(event);
        }}
        onCompositionStart={(event) => {
          setIsComposing(true);
          onCompositionStart?.(event);
        }}
        onScroll={(event) => {
          if (backdropRef.current) backdropRef.current.scrollLeft = event.currentTarget.scrollLeft;
          onScroll?.(event);
        }}
        value={value}
      />
    </div>
  );
}

function segments(
  value: string,
  tokens: QuickAddHighlightToken[],
  priorityClass: string
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) nodes.push(value.slice(cursor, token.start));

    const colour = token.kind === "priority" ? priorityClass : KIND_CLASS[token.kind];
    nodes.push(
      <span className={colour} key={token.start}>
        {value.slice(token.start, token.end)}
      </span>
    );
    cursor = token.end;
  }

  if (cursor < value.length) nodes.push(value.slice(cursor));

  return nodes;
}
