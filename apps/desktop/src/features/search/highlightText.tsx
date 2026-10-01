import type { ReactNode } from "react";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mark the query inside `text`. What was typed wins where it appears verbatim, so
 *  an address or a phrase is one mark rather than its tokens lit up in every
 *  neighbour that shares one ("example.com" in each guest). Otherwise the tokens
 *  the index matched are marked, because "multi-color" is a hit on "multi color". */
export function highlightText(text: string, queryWords: string[], typed: string): ReactNode {
  const phrase = typed.trim();
  const verbatim = phrase !== "" && text.toLowerCase().includes(phrase.toLowerCase());
  const terms = verbatim ? [phrase] : queryWords;
  if (!text || terms.length === 0) return text;

  // One capturing group, so split() puts every match at an odd index.
  const parts = text.split(new RegExp(`(${terms.map(escape).join("|")})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span className="font-medium text-primary" key={i}>
        {part}
      </span>
    ) : (
      part
    )
  );
}
