import { Extension } from "@tiptap/core";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";

function withoutAlign<T extends Record<string, unknown>>(attributes: T): Omit<T, "align"> {
  const { align: _align, ...rest } = attributes;
  return rest;
}

const Cell = TableCell.extend({
  addAttributes() {
    return withoutAlign(this.parent?.() ?? {});
  },
});

const Header = TableHeader.extend({
  addAttributes() {
    return withoutAlign(this.parent?.() ?? {});
  },
});

/**
 * Tables, bundled as one extension so callers cannot register only some of the node types
 * and parse existing documents lossily.
 *
 * `resizable: false` is a UI choice, not a schema one: `colwidth` is declared on cells either
 * way and only a resize gesture populates it, so a resized table still parses where resizing
 * is off. It is set here so the same insert produces the same document everywhere.
 *
 * Cells drop the `align` attribute newer Tiptap adds. Keeping it would put `align` on every
 * saved cell, a stored-format change that needs its own schema version bump.
 */
export const PikosTable = Extension.create({
  addExtensions() {
    return [Table.configure({ resizable: false }), TableRow, Cell, Header];
  },
  name: "pikosTable",
});
