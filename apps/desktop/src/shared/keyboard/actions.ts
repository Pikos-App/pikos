// Shortcut combo constants — used by the keyboard registry and UI labels.
// Bindings are registered in the useKeyboard hook (GOO-31).
export const shortcuts = {
  deleteFile: "Mod+Shift+D",
  findInPage: "Mod+F",
  insertLink: "Mod+Shift+K",
  newFile: "Mod+N",
  openSettings: "Mod+,",
  pageSwitcher: "Mod+K",
} as const;
