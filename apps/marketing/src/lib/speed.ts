export type Op = { ms: number; p95: number };
export type Corpus = { pages: number; ops: Record<string, Op> };
export type Row = { op: string; label: string; flat: boolean };

export const fmtMs = (ms: number) =>
  ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();

export const fmtPages = (n: number) => n.toLocaleString("en-US");

/** A corpus holds a few pages more than it was seeded with (the bench writes some), so round
 *  to the size it was asked for. */
export const roundPages = (n: number) => {
  const magnitude = 10 ** Math.floor(Math.log10(n));
  return Math.round(n / magnitude) * magnitude;
};
