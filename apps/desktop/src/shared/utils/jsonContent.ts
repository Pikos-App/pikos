// pages.content is always written by Tiptap's getJSON(), so a parse failure means a corrupted row.
// Swallowing it would mask the corruption and throwing would crash the editor on page open: log
// and fall back to the empty doc so the user keeps using the page and the log shows the bug.

import type { JSONContent } from "@tiptap/core";

import { createLogger } from "@/shared/logger";

const log = createLogger("jsonContent");

export const EMPTY_TIPTAP_DOC: JSONContent = {
  content: [{ type: "paragraph" }],
  type: "doc",
};

/** Returns `null` for empty or missing input so callers choose their own fallback. */
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
