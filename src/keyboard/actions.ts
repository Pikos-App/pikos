import { createFile, deletePage } from "../stores/fileSystemActions";
import { selectedPage } from "../stores/fileSystemStore";
import { Keyboard } from "./registry";

export const shortcuts = {
  newFile: "Mod+N",
  deleteFile: "Mod+Shift+D",
  closeFile: "Mod+W",
};

// Register bindings in the global scope
Keyboard.register({
  id: "new-file",
  combo: shortcuts.newFile,
  scope: "global",
  handler: createFile,
  preventDefault: true,
  repeat: false,
  allowInInputs: false,
});

Keyboard.register({
  id: "delete-file",
  combo: shortcuts.deleteFile,
  scope: "global",
  handler: deletePage,
  preventDefault: true,
  repeat: false,
  allowInInputs: false,
});

Keyboard.register({
  id: "close-file",
  combo: shortcuts.closeFile,
  scope: "global",
  handler: () => selectedPage.set(null),
  preventDefault: true,
  repeat: false,
  allowInInputs: false,
});

export function handleKeydown(event: KeyboardEvent) {
  // Delegate to central registry for matching/guards/scopes
  Keyboard.handle(event);
}
