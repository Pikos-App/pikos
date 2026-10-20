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
 * Tables, bundled as one extension so callers cannot accidentally register
 * three of the four node types and end up with a schema that parses existing
 * documents into something lossy.
 *
 * `resizable: false` is a UI choice rather than a schema one — `colwidth` is
 * declared on cells either way, and only a resize gesture populates it, so a
 * table resized on a platform that allows it still parses on one that does
 * not. It is set here rather than per-platform so the same insert produces the
 * same document everywhere, which is a smaller claim than "it would corrupt
 * otherwise" but the true one.
 *
 * Cells drop the `align` attribute Tiptap 3.32 added. Keeping it would put
 * `align` on every cell the editor saves, a stored-format change that the Rust
 * Markdown importer, the phone and a device still on the older schema would
 * all have to learn; it belongs in its own change with a schema version bump.
 */
export const PikosTable = Extension.create({
  addExtensions() {
    return [Table.configure({ resizable: false }), TableRow, Cell, Header];
  },
  name: "pikosTable",
});
