// Stands in for `@tauri-apps/api/core` in the seed-workspace bundle, so the
// desktop's own TauriSQLiteAdapter reaches the `seed_workspace` Rust example
// instead of a webview.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

interface Reply {
  error?: unknown;
  id: number;
  ok: boolean;
  value?: unknown;
}

interface Waiter {
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
}

let runner: ChildProcessByStdio<Writable, Readable, null> | undefined;
let nextId = 0;
const waiting = new Map<number, Waiter>();

export function startRunner(binary: string, dbPath: string): void {
  const child = spawn(binary, [dbPath], { stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line) as Reply;
    const waiter = waiting.get(reply.id);
    waiting.delete(reply.id);
    if (reply.ok) waiter?.resolve(reply.value);
    else waiter?.reject(reply.error);
  });
  child.on("exit", (code) => {
    for (const waiter of waiting.values()) {
      waiter.reject(new Error(`seed runner exited with code ${String(code)}`));
    }
    waiting.clear();
  });
  runner = child;
}

/** Resolves once the runner has closed the workspace, so the file is complete. */
export function stopRunner(): Promise<void> {
  const child = runner;
  if (child === undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed runner exited with code ${String(code)}`));
    });
    child.stdin.end();
  });
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const child = runner;
  if (child === undefined) return Promise.reject(new Error("seed runner not started"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { reject, resolve: resolve as (value: unknown) => void });
    child.stdin.write(`${JSON.stringify({ args: args ?? {}, cmd, id })}\n`);
  });
}
