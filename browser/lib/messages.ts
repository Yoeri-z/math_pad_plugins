import type { ServerMessage } from "./protocol.ts";
import type { ConnStatus } from "./status.ts";
import type { PairState } from "./types.ts";

/** The popup asks the background for the current connection state. */
export interface GetStatusMessage {
  type: "getStatus";
}

/** The popup asks the background to reconcile registered content scripts. */
export interface SyncSitesMessage {
  type: "syncSites";
}

/** The background broadcasts connection changes to any open popup. */
export interface PairStatusMessage {
  type: "pairStatus";
  status: ConnStatus;
}

/** Reply to {@link GetStatusMessage}. */
export interface StatusResponse {
  status: ConnStatus;
  state?: PairState;
}

/**
 * The background relays one validated server message to the active tab. The
 * content script inserts text or pastes an image at the caret.
 */
export interface DeliverPayloadMessage {
  type: "deliverPayload";
  message: ServerMessage;
}

/** Reply from the content script, forwarded to the background for logging. */
export interface HandlerResponse {
  ok: boolean;
  reason?: string;
}

/** Narrows an unknown runtime message to a known shape, or null. */
export function asMessage<T extends object>(msg: unknown, type: string): T | null {
  if (typeof msg === "object" && msg !== null && "type" in msg && msg.type === type) {
    return msg as T;
  }
  return null;
}
