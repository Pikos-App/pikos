// Browser half of the e2e bridge. The app sends the same db commands it always
// sends; this points them at a localhost server running the real Rust writer
// instead of at Tauri IPC, which a browser does not have.
//
// It sits outside src/ on purpose. scripts/source-audit.sh fails the build on a
// bare `fetch(` anywhere under src/, and that check is what keeps the app's
// single-outbound-call claim honest. A test-only transport is not a reason to
// carve a hole in it.

import { setCommandTransport } from "@/shared/adapters/TauriSQLiteAdapter";

import { BRIDGE_ORIGIN } from "./origin";

/** Mirrors how Tauri resolves or rejects, so the adapter's own toStorageError
 *  conversion works on `error` unchanged. */
interface BridgeResponse<T> {
  error?: unknown;
  value?: T;
}

/** Send one command to the bridge. Exported for the dev-seed commands, which the
 *  storage adapter does not carry. */
export async function bridgeInvoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${BRIDGE_ORIGIN}/command`, {
    body: JSON.stringify({ args: args ?? {}, command, db: bridgeDbToken() }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  let payload: BridgeResponse<T>;
  try {
    payload = (await res.json()) as BridgeResponse<T>;
  } catch {
    throw new Error(`Bridge returned ${String(res.status)} with no JSON body for "${command}"`);
  }

  // eslint-disable-next-line @typescript-eslint/only-throw-error -- Tauri rejects with the raw { kind, message }; toStorageError expects exactly that
  if (payload.error !== undefined) throw payload.error;
  if (!res.ok) {
    throw new Error(`Bridge returned ${String(res.status)} for "${command}"`);
  }
  return payload.value as T;
}

export function installBridgeTransport(): void {
  setCommandTransport(bridgeInvoke);
}

declare global {
  interface Window {
    __PIKOS_E2E_DB__?: string;
  }
}

/** Which SQLite file this tab gets. The e2e fixtures plant one token per test;
 *  the server resolves it inside the directory it owns, which also keeps the
 *  browser from naming a filesystem path. */
export function bridgeDbToken(): string {
  const token = window.__PIKOS_E2E_DB__;
  if (!token) {
    throw new Error("The bridge lane needs a database token, which the e2e fixtures plant per test");
  }
  return token;
}
