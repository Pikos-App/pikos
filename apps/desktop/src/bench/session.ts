import { invoke } from "@tauri-apps/api/core";

/** What the bench build's Rust side reports: the scratch workspace to open, and how long the
 *  process has been running. */
export interface BenchSession {
  db: string;
  uptimeMs: number;
}

export function benchSession(): Promise<BenchSession> {
  return invoke<BenchSession>("bench_session");
}

/** Hand the results to Rust, which writes them where the benchmark script asked and quits. */
export function benchFinish(results: unknown): Promise<void> {
  return invoke<void>("bench_finish", { results });
}
