import type { ReactNode } from "react";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mark the query inside `text`. What was typed wins where it appears verbatim, so
 *  an address or a phrase is one mark rather than its tokens lit up in every
 *  neighbour that shares one ("example.com" in each guest). Otherwise the tokens
 *  the index matched are marked, because "multi-color" is a hit on "multi color". With no
 *  tokens the index matched nothing, so nothing is marked, whatever was typed. */
export function highlightText(text: string, queryWords: string[], typed: string): ReactNode {
  if (queryWords.length === 0) return text;
  const phrase = typed.trim();
  const verbatim = phrase && text.toLowerCase().includes(phrase.toLowerCase());
  const terms = verbatim ? [phrase] : queryWords;

  // One capturing group, so split() puts every match at an odd index.
  const parts = text.split(new RegExp(`(${terms.map(escape).join("|")})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark className="bg-transparent font-medium text-primary" key={i}>
        {part}
      </mark>
    ) : (
      part
    )
  );
}
