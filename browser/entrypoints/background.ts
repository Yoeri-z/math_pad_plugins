import { pairStatusUrl } from "../lib/api.ts";
import { API_WS } from "../lib/config.ts";
import type {
  DeliverPayloadMessage,
  GetStatusMessage,
  HandlerResponse,
  StatusResponse,
  SyncSitesMessage,
} from "../lib/messages.ts";
import { asMessage } from "../lib/messages.ts";
import { loadPairState } from "../lib/pairing.ts";
import type { ServerMessage } from "../lib/protocol.ts";
import { parseServerMessage } from "../lib/protocol.ts";
import type { ConnStatus } from "../lib/status.ts";
import {
  TRUSTED_SITES_KEY,
  syncContentScripts,
} from "../lib/trusted-sites.ts";
import type { PairState } from "../lib/types.ts";

const PING_INTERVAL_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
const BACKOFF_STEP_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

let socket: WebSocket | undefined;
/** "code:token" the socket was opened with — reopens only on actual change. */
let socketKey = "";
let status: ConnStatus = "idle";
let backoffMs = BACKOFF_STEP_MS;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Incremented by each open attempt so stale async work can bail out. */
let openAttempt = 0;

export default defineBackground(() => {
  void openSocket();

  // Dynamic registrations persist, but reconcile when the browser starts or
  // the extension is installed/updated (for example after a permission reset).
  browser.runtime.onInstalled.addListener(() => void syncSites());
  browser.runtime.onStartup.addListener(() => void syncSites());

  // A new pairing from the popup must replace the live socket.
  browser.storage.local.onChanged.addListener((changes) => {
    if ("code" in changes || "token" in changes) {
      void openSocket();
    }
    if (TRUSTED_SITES_KEY in changes) {
      void syncSites();
    }
  });

  // The popup asks for the current status when it opens.
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (asMessage<SyncSitesMessage>(message, "syncSites")) {
      void syncSites().then(() => {
        sendResponse({ ok: true } satisfies HandlerResponse);
      });
      return true; // Keep the channel open for the async reply.
    }

    if (!asMessage<GetStatusMessage>(message, "getStatus")) {
      return undefined;
    }

    void loadStatusResponse()
      .then(sendResponse)
      .catch((error: unknown) => {
        console.warn("[mathpad] could not load status", error);
        sendResponse({ status } satisfies StatusResponse);
      });
    return true; // Keep the channel open for the async reply.
  });
});

/** Opens (or reopens) the /ws socket for the stored pairing. */
async function openSocket(): Promise<void> {
  stopRetry();
  const attempt = ++openAttempt;

  const state = await loadPairState().catch((error: unknown) => {
    console.warn("[mathpad] could not load the stored pairing", error);
    return undefined;
  });
  if (attempt !== openAttempt) {
    return;
  }

  const key = state ? `${state.code}:${state.token}` : "";
  if (socket && key === socketKey) {
    if (socket.readyState === WebSocket.OPEN) {
      if (state) {
        setStatus("listening");
      }
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      return;
    }
  }

  closeSocket();
  if (!state) {
    setStatus("idle");
    return;
  }

  socketKey = key;
  setStatus("connecting");

  // The server holds pairings in memory, so a server restart invalidates our
  // stored credentials. Asking first avoids an endless reconnect loop.
  const valid = await pairingValid(state);
  if (attempt !== openAttempt) {
    return;
  }
  if (!valid) {
    closeSocket();
    setStatus("expired");
    return;
  }

  const connected = await connect(state);
  if (attempt !== openAttempt) {
    return;
  }
  if (!connected) {
    closeSocket();
    scheduleRetry();
    return;
  }
  if (socket?.readyState !== WebSocket.OPEN) {
    return; // Closed while connecting; the close handler scheduled a retry.
  }

  backoffMs = BACKOFF_STEP_MS;
  setStatus("listening");
  startPing();
  startClaimPolling(state);
}

/** True when the server still recognizes this pairing (auth-wise). */
async function pairingValid(state: PairState): Promise<boolean> {
  try {
    const response = await fetch(pairStatusUrl(state));
    return response.status !== 401;
  } catch {
    return true; // Server unreachable: try the socket anyway, it retries.
  }
}

/** Polls the server until a phone claims the pairing, then shows Paired. */
function startClaimPolling(state: PairState): void {
  stopClaimPolling();

  const check = async (): Promise<void> => {
    if (status === "listening" && (await isPairingClaimed(state))) {
      stopClaimPolling();
      setStatus("paired");
    }
  };

  void check();
  pollTimer = setInterval(() => void check(), POLL_INTERVAL_MS);
}

async function isPairingClaimed(state: PairState): Promise<boolean> {
  try {
    const response = await fetch(pairStatusUrl(state));
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { claimed?: unknown };
    return body.claimed === true;
  } catch {
    return false; // Network hiccup: keep polling.
  }
}

function stopClaimPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

/** Resolves once the socket is open (true) or errored (false). */
function connect(state: PairState): Promise<boolean> {
  const query = new URLSearchParams({
    code: state.code,
    token: state.token,
  });
  const ws = new WebSocket(`${API_WS}?${query}`);
  socket = ws;

  return new Promise<boolean>((resolve) => {
    let opened = false;

    ws.onopen = () => {
      opened = true;
      resolve(true);
    };
    ws.onerror = () => {
      if (!opened) {
        resolve(false);
      }
    };
    ws.onmessage = (event) => {
      if (socket === ws) {
        void relayFrame(String(event.data));
      }
    };
    ws.onclose = () => {
      if (socket !== ws) {
        resolve(false);
        return;
      }
      teardown();
      if (opened) {
        scheduleRetry();
      } else {
        resolve(false);
      }
    };
  });
}

function scheduleRetry(): void {
  stopRetry();
  setStatus("connecting");
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void openSocket();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function stopRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

/** Keepalive ping for the MV3 service worker. */
function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send("ping");
    }
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  clearInterval(pingTimer);
  pingTimer = undefined;
}

function closeSocket(): void {
  stopRetry();
  const current = socket;
  socket = undefined;
  socketKey = "";
  current?.close();
  teardown();
}

/** Releases timers and the socket reference without closing anything. */
function teardown(): void {
  stopClaimPolling();
  stopPing();
  socket = undefined;
}

/** Parses one server frame and relays it to the active tab's site. */
async function relayFrame(raw: string): Promise<void> {
  const result = parseServerMessage(raw);
  if (!result.ok) {
    console.warn(`[mathpad] ignored server message (${result.reason})`);
    return;
  }
  await relayMessage(result.message);
}

/**
 * Forwards one validated message to the active tab. Content scripts only run
 * on user-trusted sites, so other pages have no receiver and the message is
 * dropped without MathPad inspecting them.
 */
async function relayMessage(message: ServerMessage): Promise<void> {
  const tab = await activeTab().catch((error: unknown) => {
    console.warn("[mathpad] could not read the active tab", error);
    return undefined;
  });
  if (tab?.id === undefined) {
    console.warn("[mathpad] no active browser tab to relay to");
    return;
  }

  try {
    const payload: DeliverPayloadMessage = { type: "deliverPayload", message };
    const result = (await browser.tabs.sendMessage(tab.id, payload)) as
      | HandlerResponse
      | undefined;
    if (result?.ok === true) {
      setStatus("paired");
      return;
    }
    console.warn(`[mathpad] ${result?.reason ?? "payload was not handled"}`);
  } catch (error) {
    console.warn(
      "[mathpad] no content script on this tab — trust this site or reload the page",
      error,
    );
  }
}

async function loadStatusResponse(): Promise<StatusResponse> {
  const state = await loadPairState();
  return { status, state };
}

async function activeTab() {
  const tabs = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tabs[0];
}

function setStatus(next: ConnStatus): void {
  status = next;
  void browser.runtime
    .sendMessage({ type: "pairStatus", status: next })
    .catch(() => {
      // The popup is closed: there is no receiver, which is safe to ignore.
    });
}

/** Reconciles registered content scripts with the trusted-site list. */
async function syncSites(): Promise<void> {
  try {
    await syncContentScripts();
  } catch (error) {
    console.warn("[mathpad] could not sync trusted sites", error);
  }
}
