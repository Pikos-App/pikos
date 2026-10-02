/** Milliseconds: the median run, the 95th percentile, and the slowest run. */
export type Op = { ms: number; p95: number; max: number };
/** `seeded` is the size the workspace was built at; `pages` is what it held when timed. */
export type Corpus = { seeded: number; pages: number; ops: Record<string, Op> };
export type Row = { op: string; label: string; flat: boolean };

export const fmtMs = (ms: number) =>
  ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();

export const fmtPages = (n: number) => n.toLocaleString("en-US");
