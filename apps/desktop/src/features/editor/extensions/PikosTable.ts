import { Extension } from "@tiptap/core";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";

export const PikosTable = Extension.create({
  addExtensions() {
    return [Table.configure({ resizable: false }), TableRow, TableCell, TableHeader];
  },
  name: "pikosTable",
});
