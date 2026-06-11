// Lightweight event emitter for workspace-level lifecycle and CRUD events.
// Lives outside WorkspaceContext so callers (e.g. useEditorPage) can subscribe
// without pulling in the full provider tree, and so the emitter can be unit-
// tested without React.

import type { Page, Workspace } from "@pikos/core";

export type WorkspaceEvent = "page:created" | "page:updated" | "page:deleted" | "workspace:loaded";

export interface WorkspaceEventPayloadMap {
  "page:created": Page;
  "page:updated": Page;
  "page:deleted": string;
  "workspace:loaded": Workspace;
}

type AnyHandler = (payload: unknown) => void;

export interface WorkspaceEventBus {
  emit: <E extends WorkspaceEvent>(event: E, payload: WorkspaceEventPayloadMap[E]) => void;
  on: <E extends WorkspaceEvent>(
    event: E,
    handler: (payload: WorkspaceEventPayloadMap[E]) => void
  ) => () => void;
}

export function createWorkspaceEventBus(): WorkspaceEventBus {
  const listeners = new Map<WorkspaceEvent, Set<AnyHandler>>();

  function emit<E extends WorkspaceEvent>(event: E, payload: WorkspaceEventPayloadMap[E]): void {
    listeners.get(event)?.forEach((h) => h(payload as unknown));
  }

  function on<E extends WorkspaceEvent>(
    event: E,
    handler: (payload: WorkspaceEventPayloadMap[E]) => void
  ): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler as AnyHandler);
    return () => {
      listeners.get(event)?.delete(handler as AnyHandler);
    };
  }

  return { emit, on };
}
