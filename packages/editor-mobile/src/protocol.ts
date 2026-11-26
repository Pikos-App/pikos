// The editor bridge protocol, declared once as plain data. The TypeScript types and
// validators derive from it, and `scripts/gen-swift-protocol.ts` emits the Swift types, so
// the two ends cannot drift: a hand-renamed field would not fail to compile, it would
// arrive as undefined and the editor would quietly stop saving.
//
// Wire format for every message:
//
//   { "v": 1, "type": "docChanged", "payload": { ... } }
//
// The version rides every message because an app update can replace the native shell while
// a webview is still live, so the receiver can reject what it does not understand.

export const PROTOCOL_VERSION = 1;

export type FieldType =
  | "string"
  /** Distinct from `number` so Swift gets an `Int`. */
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "stringArray";

export interface MessageSpec {
  readonly doc: string;
  readonly fields: Readonly<Record<string, FieldType>>;
}

/** Host to webview. Swift owns persistence, so these only say what to show and where focus goes. */
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
  setEditable: {
    doc: "Make the document read-only or editable. The host sends false for a page written by a newer schema than it can save, so the surface refuses input instead of accepting keystrokes it will never persist.",
    fields: { editable: "boolean" },
  },
  setTheme: {
    doc: "Apply the host's colour scheme so the editor matches the app around it.",
    fields: { accent: "string", scheme: "string" },
  },
  toggleBlock: {
    doc: "Toggle the block type of the selection — paragraph, heading, bulletList, orderedList, taskList, blockquote or codeBlock. `headingLevel` is read only when nodeType is heading, and ignored otherwise.",
    fields: { headingLevel: "integer", nodeType: "string" },
  },
  toggleMark: {
    doc: "Toggle an inline mark on the selection — bold, italic, underline, strike or code. Named rather than enumerated so the two ends need not agree on an ordering; an unknown mark is ignored.",
    fields: { mark: "string" },
  },
} as const satisfies Record<string, MessageSpec>;

/** Webview to host. */
export const WEBVIEW_TO_HOST = {
  docChanged: {
    doc: "The document changed. Debounced in the webview. `plainText` is the extracted text for the search index, sent alongside so the host does not have to re-derive it.",
    fields: { doc: "json", pageId: "string", plainText: "string" },
  },
  heightChanged: {
    doc: "The content's height in CSS pixels, for hosts sizing the webview inline rather than letting it scroll itself.",
    fields: { px: "number" },
  },
  inputTiming: {
    doc: "How long the keystrokes since the last report took from input to the next painted frame, sent with each docChanged. What the phone's typing speed is measured by.",
    fields: { count: "integer", medianMs: "number", worstMs: "number" },
  },
  linkTapped: {
    doc: "A link was tapped. The webview does not navigate — the host decides whether to open it.",
    fields: { url: "string" },
  },
  ready: {
    doc: "The editor has mounted and can accept messages. Carries the protocol version the webview was built against so the host can refuse a mismatch loudly rather than misbehave quietly.",
    fields: { protocolVersion: "integer" },
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

type FieldValue<T extends FieldType> = T extends "string"
  ? string
  : T extends "integer" | "number"
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

function isValid(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      // NaN and Infinity serialise as null through JSON.
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "stringArray":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "json":
      // The editor validates the document itself.
      return value !== undefined;
  }
}

/**
 * Returns the parsed envelope, or an error string explaining the rejection. It never throws:
 * the caller is a message handler at the platform boundary, where a throw loses the context.
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

export function envelope<T extends WebviewToHostType>(
  type: T,
  payload: WebviewToHostPayload<T>
): Envelope<T, WebviewToHostPayload<T>> {
  return { payload, type, v: PROTOCOL_VERSION };
}
