import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import App from "./App";

// Suppress the WebView's native right-click menu globally.
// Radix ContextMenu calls preventDefault() on events it handles, so custom
// menus still work — this only blocks the OS menu on non-interactive areas.
document.addEventListener("contextmenu", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
