/** Milliseconds: the median run, the time 99 in 100 runs beat, and the slowest; then how many runs. */
export type Op = { ms: number; p99: number; max: number; runs: number };
/** `seeded` is the size the workspace was built at; `pages` is what it held when timed. */
export type Corpus = { seeded: number; pages: number; ops: Record<string, Op> };
export type Row = { op: string; label: string; flat: boolean };

export const fmtMs = (ms: number) =>
  ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();

export const fmtPages = (n: number) => n.toLocaleString("en-US");
