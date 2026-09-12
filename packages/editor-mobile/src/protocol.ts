// The editor bridge protocol — one declaration, both sides.
//
// The webview and the host app exchange JSON messages, and the two ends are
// written in different languages by different toolchains. Left to hand-written
// definitions on each side they drift, and the failure mode is bad: a renamed
// field does not fail to compile, it silently arrives as undefined and the
// editor quietly stops saving.
//
// So the protocol is declared once, here, as plain data. The TypeScript types
// and runtime validators are derived from it, and `scripts/gen-swift-protocol.ts`
// emits matching Swift `Codable` types from the same declaration. Neither side
// is authored by hand, so neither can drift from the other.
//
// Wire format for every message:
//
//   { "v": 1, "type": "docChanged", "payload": { ... } }
//
// The version is on every message rather than negotiated once at startup. An
// app update can replace the native shell while a webview is still live, and a
// version on the envelope means the receiver can reject a message it does not
// understand instead of misreading it.

export const PROTOCOL_VERSION = 1;

/** Field types the bridge can carry. Deliberately small. */
export type FieldType = "string" | "number" | "boolean" | "json" | "stringArray";

export interface MessageSpec {
  readonly doc: string;
  readonly fields: Readonly<Record<string, FieldType>>;
}

/**
 * Host → webview.
 *
 * Swift owns persistence, so nothing here writes to a database; these are
 * instructions to the editor about what to show and where focus should be.
 */
export const HOST_TO_WEBVIEW = {
  blur: {
    doc: "Release focus and dismiss the keyboard.",
    fields: {},
  },
  focus: {
    doc: "Put the caret in the editor and raise the keyboard.",
    fields: {},
  },
  insertImage: {
    doc: "Insert an image the host has already saved into the workspace. `assetPath` is the durable reference stored in the document; the webview resolves it for display.",
    fields: { assetPath: "string" },
  },
  load: {
    doc: "Replace the editor's contents with a page's document.",
    fields: { doc: "json", pageId: "string" },
  },
  setTheme: {
    doc: "Apply the host's colour scheme so the editor matches the app around it.",
    fields: { accent: "string", scheme: "string" },
  },
} as const satisfies Record<string, MessageSpec>;

/**
 * Webview → host.
 *
 * The rule from the plan, and the one that matters most: the webview never
 * talks to the database. It reports what happened; Swift decides what to store.
 */
export const WEBVIEW_TO_HOST = {
  docChanged: {
    doc: "The document changed. Debounced in the webview. `plainText` is the extracted text for the search index, sent alongside so the host does not have to re-derive it.",
    fields: { doc: "json", pageId: "string", plainText: "string" },
  },
  heightChanged: {
    doc: "The content's height in CSS pixels, for hosts sizing the webview inline rather than letting it scroll itself.",
    fields: { px: "number" },
  },
  linkTapped: {
    doc: "A link was tapped. The webview does not navigate — the host decides whether to open it.",
    fields: { url: "string" },
  },
  ready: {
    doc: "The editor has mounted and can accept messages. Carries the protocol version the webview was built against so the host can refuse a mismatch loudly rather than misbehave quietly.",
    fields: { protocolVersion: "number" },
  },
  requestImagePicker: {
    doc: "The user asked to insert an image. The host presents a picker and replies with insertImage.",
    fields: {},
  },
  selectionChanged: {
    doc: "The selection moved. Drives the native formatting toolbar, so it fires on every selection change and must stay cheap.",
    fields: { isEmpty: "boolean", marks: "stringArray", nodeType: "string" },
  },
} as const satisfies Record<string, MessageSpec>;

export type HostToWebviewType = keyof typeof HOST_TO_WEBVIEW;
export type WebviewToHostType = keyof typeof WEBVIEW_TO_HOST;

/** Maps a declared field type onto its TypeScript counterpart. */
type FieldValue<T extends FieldType> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "stringArray"
        ? string[]
        : unknown;

type PayloadOf<S extends MessageSpec> = {
  [K in keyof S["fields"]]: FieldValue<S["fields"][K]>;
};

export type HostToWebviewPayload<T extends HostToWebviewType> = PayloadOf<
  (typeof HOST_TO_WEBVIEW)[T]
>;
export type WebviewToHostPayload<T extends WebviewToHostType> = PayloadOf<
  (typeof WEBVIEW_TO_HOST)[T]
>;

export interface Envelope<T extends string, P> {
  v: number;
  type: T;
  payload: P;
}

/** Runtime shape check for one field. */
function isValid(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      // NaN and Infinity serialise as null through JSON and would arrive as a
      // number-typed hole, so they are rejected here rather than downstream.
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "stringArray":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "json":
      // Any JSON value is acceptable; the editor validates the document itself.
      return value !== undefined;
  }
}

/**
 * Validate an incoming host → webview message.
 *
 * Returns the parsed envelope, or an error string explaining the rejection.
 * Errors are returned rather than thrown because the caller is a message
 * handler at the platform boundary: throwing there loses the context needed to
 * report the problem back across the bridge.
 */
export function parseHostMessage(
  raw: unknown
):
  | { ok: true; type: HostToWebviewType; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "message is not an object", ok: false };
  }
  const envelope = raw as Partial<Envelope<string, unknown>>;

  if (envelope.v !== PROTOCOL_VERSION) {
    return {
      error: `protocol version ${String(envelope.v)} is not supported (this build speaks ${PROTOCOL_VERSION})`,
      ok: false,
    };
  }
  const type = envelope.type;
  if (typeof type !== "string" || !(type in HOST_TO_WEBVIEW)) {
    return { error: `unknown message type: ${String(type)}`, ok: false };
  }
  const spec = HOST_TO_WEBVIEW[type as HostToWebviewType];
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;

  for (const [field, fieldType] of Object.entries(spec.fields)) {
    if (!isValid(payload[field], fieldType)) {
      return {
        error: `message "${type}" field "${field}" should be ${fieldType}`,
        ok: false,
      };
    }
  }
  return { ok: true, payload, type: type as HostToWebviewType };
}

/** Build a webview → host envelope. */
export function envelope<T extends WebviewToHostType>(
  type: T,
  payload: WebviewToHostPayload<T>
): Envelope<T, WebviewToHostPayload<T>> {
  return { payload, type, v: PROTOCOL_VERSION };
}
