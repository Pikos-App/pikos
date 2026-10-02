/** Milliseconds: the median run, the time 99 in 100 runs beat, and the slowest; then how many runs. */
export type Op = { ms: number; p99: number; max: number; runs: number };
/** `seeded` is the size the workspace was built at; `pages` is what it held when timed. */
export type Corpus = { seeded: number; pages: number; ops: Record<string, Op> };

/** One measured action across every workspace size, `null` where a size produced no number. */
export type Series = {
  key: string;
  /** Its row in the table. */
  label: string;
  /** Its button over the bars. */
  button: string;
  /** Its column heading beside the bars. */
  heading: string;
  values: (Op | null)[];
};

export const fmtMs = (ms: number) =>
  ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();

/** Milliseconds below a second, seconds from there, so a launch reads "1.4 s" rather than "1425 ms". */
export const fmtTime = (ms: number) =>
  ms < 1000 ? `${fmtMs(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

export const fmtPages = (n: number) => n.toLocaleString("en-US");
