// Defensive parser for Tiptap JSON content blobs persisted in pages.content.
//
// pages.content is *always* written by Tiptap's own getJSON() output, so a
// parse failure means the row is corrupted (manual DB edit, partial write,
// or a future schema bump that wasn't migrated). Silently swallowing the
// error would mask the corruption; throwing would crash the editor on
// page open. Log + fall back to the empty doc so the user can keep using
// the page, and the bug shows up in the log file.

import type { JSONContent } from "@tiptap/core";

import { createLogger } from "@/shared/logger";

const log = createLogger("jsonContent");

export const EMPTY_TIPTAP_DOC: JSONContent = {
  content: [{ type: "paragraph" }],
  type: "doc",
};

/**
 * Parse a Tiptap JSON document string. Returns `null` for empty/missing
 * input so callers can choose their own fallback (some need an empty doc,
 * some need to skip the operation). Logs at error severity on parse
 * failure — a corrupted document is the kind of thing we want surfaced
 * in bug reports.
 */
export function tryParseTiptapJson(
  raw: string | null | undefined,
  context: string
): JSONContent | null {
  if (raw == null || raw === "" || raw === "{}") return null;
  try {
    return JSON.parse(raw) as JSONContent;
  } catch (err) {
    log.error(`${context}: failed to parse Tiptap JSON content`, err);
    return null;
  }
}
