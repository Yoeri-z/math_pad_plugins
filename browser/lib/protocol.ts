/**
 * The extension-facing server contract.
 *
 * Every server -> extension WebSocket frame is one JSON object:
 *
 *   {"version":1,"id":"...","datatype":"latex","sent_at":"...","payload":"..."}
 *
 * The datatype says how to consume the payload. Text-like datatypes carry
 * text; image datatypes (image/...) carry single-line base64 image data.
 * Unknown datatypes are rejected so the background can ignore them safely.
 */
export const PROTOCOL_VERSION = 1 as const;

/** Decoded image payloads are capped at 8 MiB, matching the server. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const DATATYPE_PATTERN = /^[a-z][a-z0-9._+-]*(?:\/[a-z0-9][a-z0-9.+-]*)?$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const TEXT_DATATYPES = new Set<string>([
  "plaintext",
  "latex",
  "smiles",
  "tikz",
]);

export type TextDataType = "plaintext" | "latex" | "smiles" | "tikz";
export type ImageDataType = `image/${string}`;
/** Open string union: future datatypes still parse as strings. */
export type DataType = TextDataType | ImageDataType | (string & {});

export interface Envelope {
  version: 1;
  id: string;
  datatype: DataType;
  sent_at: string;
  payload: string;
}

export interface TextMessage extends Envelope {
  datatype: TextDataType;
}

export interface ImageMessage extends Envelope {
  datatype: ImageDataType;
}

export type ServerMessage = TextMessage | ImageMessage;

export type ParseResult =
  | { ok: true; message: ServerMessage }
  | {
      ok: false;
      reason: "unsupported-datatype";
      datatype: string;
      message: Envelope;
    }
  | { ok: false; reason: string; datatype?: string };

/** Parses one raw WebSocket text frame, returning a safe result either way. */
export function parseServerMessage(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "frame is not valid JSON" };
  }
  return parseEnvelope(value);
}

function parseEnvelope(value: unknown): ParseResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "message must be a JSON object" };
  }
  if (value.version !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `unsupported protocol version ${String(value.version)}`,
    };
  }

  const datatype = typeof value.datatype === "string" ? value.datatype : undefined;
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    return { ok: false, reason: "invalid id", datatype };
  }
  if (!datatype || !DATATYPE_PATTERN.test(datatype)) {
    return { ok: false, reason: "invalid datatype", datatype };
  }
  if (typeof value.sent_at !== "string" || Number.isNaN(Date.parse(value.sent_at))) {
    return { ok: false, reason: "invalid sent_at", datatype };
  }
  if (typeof value.payload !== "string") {
    return { ok: false, reason: "payload must be a string", datatype };
  }

  const envelope: Envelope = {
    version: PROTOCOL_VERSION,
    id: value.id,
    datatype,
    sent_at: value.sent_at,
    payload: value.payload,
  };

  if (isTextDataType(datatype)) {
    return parseText(envelope, datatype);
  }
  if (isImageDataType(datatype)) {
    return parseImage(envelope, datatype);
  }
  return { ok: false, reason: "unsupported-datatype", datatype, message: envelope };
}

function parseText(envelope: Envelope, datatype: TextDataType): ParseResult {
  if (envelope.payload.trim().length === 0) {
    return { ok: false, reason: "text payload must not be empty", datatype };
  }
  return { ok: true, message: { ...envelope, datatype } };
}

function parseImage(envelope: Envelope, datatype: ImageDataType): ParseResult {
  const error = validateImagePayload(envelope.payload);
  if (error) {
    return { ok: false, reason: error, datatype };
  }
  return { ok: true, message: { ...envelope, datatype } };
}

function validateImagePayload(payload: string): string | null {
  if (payload.length === 0) {
    return "image payload must not be empty";
  }
  if (payload.length > MAX_BASE64_LENGTH) {
    return "image too large";
  }
  if (payload.length % 4 !== 0 || !BASE64_PATTERN.test(payload)) {
    return "image payload must be single-line base64";
  }

  try {
    if (atob(payload).length > MAX_IMAGE_BYTES) {
      return "image too large";
    }
  } catch {
    return "image payload is not valid base64";
  }
  return null;
}

function isTextDataType(value: string): value is TextDataType {
  return TEXT_DATATYPES.has(value);
}

function isImageDataType(value: string): value is ImageDataType {
  return value.startsWith("image/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
