export interface InputTimingSummary {
  count: number;
  medianMs: number;
  worstMs: number;
}

/**
 * Keystroke latency, from the input event to the start of the frame that draws its result.
 *
 * The clock starts at `beforeinput` and stops in the next animation frame after the document
 * updates. A second keystroke before that frame joins the same measurement, since the same
 * frame draws both.
 */
export function createInputTimings(
  now: () => number = () => performance.now(),
  nextFrame: (callback: () => void) => void = (callback) => requestAnimationFrame(callback)
) {
  let startedAt: number | null = null;
  let samples: number[] = [];

  return {
    /** Null when there were no keystrokes since the last call. */
    drain(): InputTimingSummary | null {
      if (samples.length === 0) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      samples = [];
      return {
        count: sorted.length,
        medianMs: sorted[Math.floor(sorted.length / 2)]!,
        worstMs: sorted[sorted.length - 1]!,
      };
    },
    finishOnNextFrame(): void {
      if (startedAt === null) return;
      const began = startedAt;
      startedAt = null;
      nextFrame(() => samples.push(now() - began));
    },
    start(): void {
      startedAt ??= now();
    },
  };
}
