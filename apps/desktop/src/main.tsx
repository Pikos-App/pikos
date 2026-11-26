import "./app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { loadMockStorage } from "./shared/adapters/mockStorageChunk";
import { STORAGE_BACKEND } from "./shared/constants/testMode";
import { installGlobalErrorHandlers } from "./shared/logger";

installGlobalErrorHandlers();

// Radix ContextMenu preventDefault()s events it handles, so custom menus still work; this only
// blocks the OS menu on non-interactive areas.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  // Allow native context menu inside the editor (for spellcheck suggestions)
  if (target.closest(".editor-content")) return;
  e.preventDefault();
});

// ProseMirror preventDefault()s inside its own drop handler, so in-editor drops still work.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

async function mount() {
  // Fetched before the first render because WorkspaceProvider picks its adapter synchronously.
  // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: the e2e lane always runs the bridge backend; only another build takes this branch
  if (STORAGE_BACKEND === "mock") await loadMockStorage();
  // Stryker disable next-line ConditionalExpression: the e2e lane always runs the bridge backend; only another build takes this branch
  if (STORAGE_BACKEND === "bridge") (await import("@bridge/transport")).installBridgeTransport();

  const root = document.getElementById("root");
  if (!root) throw new Error("#root element not found");

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void mount();
