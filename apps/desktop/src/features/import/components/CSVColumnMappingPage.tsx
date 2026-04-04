// CSVColumnMappingPage — full-page column mapping UI for CSV imports.
// Renders in the settings content area. Users assign CSV columns to Pikos fields
// and map enum values (status, priority) before proceeding to the import preview.

import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { detectUniqueValues, suggestValueMappings } from "../parsers/csv";
import type {
  ColumnMapping,
  CSVMappingConfig,
  PikosFieldKey,
  ValueMapping,
} from "../parsers/types";

// ─── Field definitions ───────────────────────────────────────────────────────

const PIKOS_FIELDS: { key: PikosFieldKey; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "body", label: "Body / Content" },
  { key: "folder", label: "Folder" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "tags", label: "Tags" },
  { key: "scheduledStart", label: "Scheduled Start" },
  { key: "scheduledEnd", label: "Scheduled End" },
  { key: "createdAt", label: "Created Date" },
  { key: "completedAt", label: "Completed Date" },
  { key: "updatedAt", label: "Updated Date" },
  { key: "sourceId", label: "Source ID" },
  { key: "sourceParentId", label: "Parent ID" },
  { key: "skip", label: "Skip" },
];

const STATUS_OPTIONS = [
  { label: "Active", value: "not_started" },
  { label: "Completed", value: "done" },
];

const PRIORITY_OPTIONS = [
  { label: "None", value: "0" },
  { label: "Urgent", value: "1" },
  { label: "High", value: "2" },
  { label: "Medium", value: "3" },
  { label: "Low", value: "4" },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface CSVColumnMappingPageProps {
  headers: string[];
  rows: Record<string, string>[];
  initialConfig: CSVMappingConfig;
  onConfirm: (config: CSVMappingConfig) => void;
  onCancel: () => void;
}

export function CSVColumnMappingPage({
  headers,
  initialConfig,
  onCancel,
  onConfirm,
  rows,
}: CSVColumnMappingPageProps) {
  const [columnMappings, setColumnMappings] = useState<ColumnMapping[]>(
    initialConfig.columnMappings
  );
  const [valueMappings, setValueMappings] = useState<ValueMapping[]>(initialConfig.valueMappings);

  const hasTitleMapped = columnMappings.some((cm) => cm.pikosField === "title");
  const mappedCount = columnMappings.filter((cm) => cm.pikosField !== "skip").length;

  // Which fields need value mapping
  const statusMapping = columnMappings.find((cm) => cm.pikosField === "status");
  const priorityMapping = columnMappings.find((cm) => cm.pikosField === "priority");

  function handleFieldChange(csvHeader: string, newField: PikosFieldKey) {
    setColumnMappings((prev) => {
      const updated = prev.map((cm) => {
        // Update the target column
        if (cm.csvHeader === csvHeader) {
          return { ...cm, pikosField: newField };
        }
        // Auto-reassign duplicate to skip (except "skip" which allows multiples)
        if (newField !== "skip" && cm.pikosField === newField) {
          return { ...cm, pikosField: "skip" as PikosFieldKey };
        }
        return cm;
      });
      return updated;
    });

    // Recalculate value mappings when status or priority changes
    if (newField === "status" || newField === "priority") {
      const uniqueVals = detectUniqueValues(rows, csvHeader);
      const suggested = suggestValueMappings(newField, uniqueVals, initialConfig.detectedSource);
      setValueMappings((prev) => {
        const filtered = prev.filter((vm) => vm.field !== newField);
        return [...filtered, suggested];
      });
    } else {
      // If we just un-mapped status or priority, remove its value mapping
      const oldMapping = columnMappings.find((cm) => cm.csvHeader === csvHeader);
      if (
        oldMapping &&
        (oldMapping.pikosField === "status" || oldMapping.pikosField === "priority")
      ) {
        setValueMappings((prev) => prev.filter((vm) => vm.field !== oldMapping.pikosField));
      }
    }
  }

  function handleValueMappingChange(
    field: "status" | "priority",
    sourceValue: string,
    targetValue: string
  ) {
    setValueMappings((prev) =>
      prev.map((vm) => {
        if (vm.field !== field) return vm;
        return {
          ...vm,
          entries: vm.entries.map((e) =>
            e.sourceValue === sourceValue ? { ...e, targetValue } : e
          ),
        };
      })
    );
  }

  function handleConfirm() {
    onConfirm({
      columnMappings,
      detectedSource: initialConfig.detectedSource,
      valueMappings,
    });
  }

  // Sample rows for preview (first 3)
  const sampleRows = rows.slice(0, 3);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-8 py-4">
        <button
          aria-label="Cancel import"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onCancel}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Map CSV Columns</h2>
          <p className="text-sm text-muted-foreground">
            {initialConfig.detectedSource
              ? `Auto-detected as ${initialConfig.detectedSource} — `
              : ""}
            {mappedCount} of {headers.length} columns mapped
            {!hasTitleMapped && <span className="ml-2 text-yellow-500">— Title is required</span>}
          </p>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-8 py-4">
        {/* Sample data preview */}
        <div className="mb-6">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Sample Data</h3>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  {headers.map((h) => (
                    <th
                      className="px-3 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground"
                      key={h}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((row, i) => (
                  <tr className="border-b border-border/50 last:border-0" key={i}>
                    {headers.map((h) => (
                      <td
                        className="max-w-[200px] truncate px-3 py-1.5 font-mono whitespace-nowrap text-muted-foreground"
                        key={h}
                      >
                        {row[h] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Column mapping */}
        <div className="mb-6">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Column Mapping</h3>
          <div className="space-y-1">
            {columnMappings.map((cm) => (
              <div
                className="flex items-center gap-3 rounded-md border border-border/40 bg-card px-4 py-2"
                key={cm.csvHeader}
              >
                {/* CSV column name */}
                <div className="w-40 shrink-0">
                  <p className="text-sm font-medium">{cm.csvHeader}</p>
                  {cm.sampleValues.length > 0 && (
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {cm.sampleValues[0]}
                    </p>
                  )}
                </div>

                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />

                {/* Pikos field select */}
                <div className="relative">
                  <select
                    className={cn(
                      "appearance-none rounded-md border border-border bg-background px-3 py-1.5 pr-8 text-sm transition-colors hover:bg-accent",
                      cm.pikosField === "skip" && "text-muted-foreground",
                      cm.pikosField === "title" && "border-primary/50 text-primary"
                    )}
                    onChange={(e) =>
                      handleFieldChange(cm.csvHeader, e.target.value as PikosFieldKey)
                    }
                    value={cm.pikosField}
                  >
                    {PIKOS_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Value mapping: Status */}
        {statusMapping && (
          <ValueMappingSection
            field="status"
            header={statusMapping.csvHeader}
            onChange={handleValueMappingChange}
            options={STATUS_OPTIONS}
            valueMappings={valueMappings}
          />
        )}

        {/* Value mapping: Priority */}
        {priorityMapping && (
          <ValueMappingSection
            field="priority"
            header={priorityMapping.csvHeader}
            onChange={handleValueMappingChange}
            options={PRIORITY_OPTIONS}
            valueMappings={valueMappings}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-8 py-4">
        <button
          className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={!hasTitleMapped}
          onClick={handleConfirm}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ─── Value mapping section ───────────────────────────────────────────────────

function ValueMappingSection({
  field,
  header,
  onChange,
  options,
  valueMappings,
}: {
  field: "status" | "priority";
  header: string;
  options: { label: string; value: string }[];
  valueMappings: ValueMapping[];
  onChange: (field: "status" | "priority", sourceValue: string, targetValue: string) => void;
}) {
  const mapping = valueMappings.find((vm) => vm.field === field);
  if (!mapping || mapping.entries.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        {field === "status" ? "Status" : "Priority"} Values
        <span className="ml-1 font-normal">({header})</span>
      </h3>
      <div className="space-y-1">
        {mapping.entries.map((entry) => (
          <div
            className="flex items-center gap-3 rounded-md border border-border/40 bg-card px-4 py-2"
            key={entry.sourceValue}
          >
            <span className="w-32 shrink-0 font-mono text-sm">{entry.sourceValue}</span>
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <div className="relative">
              <select
                className="appearance-none rounded-md border border-border bg-background px-3 py-1.5 pr-8 text-sm transition-colors hover:bg-accent"
                onChange={(e) => onChange(field, entry.sourceValue, e.target.value)}
                value={entry.targetValue}
              >
                {options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
