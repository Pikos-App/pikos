import "./app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";

// Suppress the WebView's native right-click menu globally.
// Radix ContextMenu calls preventDefault() on events it handles, so custom
// menus still work — this only blocks the OS menu on non-interactive areas.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  // Allow native context menu inside the editor (for spellcheck suggestions)
  if (target.closest(".editor-content")) return;
  e.preventDefault();
});

// Suppress the browser's default file-drop behavior (navigate to file URL).
// ProseMirror's editor calls preventDefault inside its own drop handler, so
// in-editor drops still work; this only catches drops on non-editor areas.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
