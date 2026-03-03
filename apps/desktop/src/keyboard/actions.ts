// Shortcut combo constants — used by the keyboard registry and UI labels.
// Bindings are registered in the useKeyboard hook (GOO-31).
export const shortcuts = {
  newFile: "Mod+N",
  deleteFile: "Mod+Shift+D",
  closeFile: "Mod+W",
  pageSwitcher: "Mod+P",
} as const;
