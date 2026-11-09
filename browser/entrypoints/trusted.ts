import {
  type InsertResult,
  insertTextAtCaret,
  pasteImageAtCaret,
} from "../lib/insert.ts";
import type {
  DeliverPayloadMessage,
  HandlerResponse,
} from "../lib/messages.ts";
import { asMessage } from "../lib/messages.ts";
import type { ServerMessage } from "../lib/protocol.ts";

/**
 * Injected only into user-trusted sites. Guarding on the isolated-world global
 * keeps a popup-triggered injection from adding duplicate listeners.
 */
const INJECTED_FLAG = "__mathpadInjected";

export default defineUnlistedScript(() => {
  const scope = globalThis as Record<string, unknown>;
  if (scope[INJECTED_FLAG]) {
    return;
  }
  scope[INJECTED_FLAG] = true;
  listen();
});

/** Delivers payloads for this tab. */
function listen(): void {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const delivery = asMessage<DeliverPayloadMessage>(message, "deliverPayload");
    if (!delivery) {
      return undefined;
    }

    sendResponse(deliver(delivery.message));
    return undefined;
  });
}

/** Pastes text or an image at the caret of the focused editor. */
function deliver(message: ServerMessage): HandlerResponse {
  try {
    const result = isImage(message)
      ? pasteImageAtCaret(message.payload, message.datatype)
      : insertTextAtCaret(message.payload);
    logFailure(result, message);
    return result;
  } catch (error) {
    console.warn("[mathpad] handler crashed", error);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function logFailure(result: InsertResult, message: ServerMessage): void {
  if (!result.ok) {
    console.info(
      `[mathpad] dropped ${message.datatype}: ${result.reason ?? "insertion failed"}`,
    );
  }
}

function isImage(message: ServerMessage): boolean {
  return message.datatype.startsWith("image/");
}
