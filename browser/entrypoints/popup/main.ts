import QRCode from "qrcode";
import { browser } from "wxt/browser";
import type {
  PairStatusMessage,
  StatusResponse,
  SyncSitesMessage,
} from "../../lib/messages.ts";
import { asMessage } from "../../lib/messages.ts";
import { pairUrl, startPairing } from "../../lib/pairing.ts";
import type { ConnStatus } from "../../lib/status.ts";
import {
  addTrustedSite,
  hasHostPermission,
  isTrustedSite,
  loadTrustedSites,
  removeTrustedSite,
  siteFromUrl,
  type TrustedSite,
} from "../../lib/trusted-sites.ts";
import type { PairState } from "../../lib/types.ts";

const QR_WIDTH_PX = 220;

const elements = {
  status: getElement("status", HTMLDivElement),
  site: getElement("site", HTMLDivElement),
  trustButton: getElement("trust", HTMLButtonElement),
  trustSiteButton: getElement("trust-site", HTMLButtonElement),
  pairButton: getElement("pair", HTMLButtonElement),
  code: getElement("code", HTMLPreElement),
  qr: getElement("qr", HTMLImageElement),
};

const STATUS_TEXT: Record<ConnStatus, string> = {
  idle: "Not paired — create a pairing to show a QR",
  connecting: "Connecting to server…",
  listening: "Waiting for your phone (scan the QR)",
  paired: "Paired — math will paste into this site",
  expired: "Pairing was refreshed — scan the new QR",
};

/** Tracks the pairing currently on screen, so status updates stay in sync. */
let displayedCode: string | undefined;
/** Guards against overlapping auto-refreshes on repeated "expired" pushes. */
let refreshing = false;
/** The site for the active tab and whether the user trusts it. */
let currentSite: TrustedSite | undefined;
let currentTabId: number | undefined;
let trusted = false;

void init().catch(showError);

async function init(): Promise<void> {
  setupStatusListener();
  elements.pairButton.addEventListener("click", () => {
    void regeneratePairing();
  });
  elements.trustButton.addEventListener("click", () => {
    void untrustSite();
  });
  elements.trustSiteButton.addEventListener("click", () => {
    void trustSite();
  });

  const tab = await activeTab();
  currentTabId = tab?.id;
  const href = await readTabUrl(tab);
  currentSite = href ? siteFromUrl(href) : undefined;

  if (!currentSite) {
    console.warn("[mathpad] could not determine the active tab URL");
    showUnsupportedPage();
    return;
  }

  const sites = await loadTrustedSites();
  trusted =
    isTrustedSite(sites, currentSite) &&
    (await hasHostPermission(currentSite.pattern));
  await renderSite();
}

/**
 * The background pushes connection changes. When it reports the pairing as
 * expired, the QR on screen is stale: replace it immediately with a fresh one
 * instead of asking the user to press the button.
 */
function setupStatusListener(): void {
  browser.runtime.onMessage.addListener((message) => {
    const update = asMessage<PairStatusMessage>(message, "pairStatus");
    if (!update || !trusted) {
      return undefined;
    }

    if (update.status === "expired" && !refreshing) {
      void regeneratePairing();
    } else {
      setStatus(update.status);
    }
    return undefined;
  });
}

/**
 * Adds the active site. The permission request must run directly from this
 * click path so the browser treats it as a user gesture.
 */
async function trustSite(): Promise<void> {
  const site = currentSite;
  if (!site) {
    return;
  }

  setTrustBusy(true);
  try {
    const granted = await browser.permissions.request({
      origins: [site.pattern],
    });
    if (!granted) {
      showMessage("Permission was denied. MathPad needs site access to paste math here.");
      return;
    }

    await addTrustedSite(site);
    await syncSites();
    trusted = true;
    await renderSite();
    // The registration is in place, so one reload activates the page.
    await reloadActiveTab();
  } catch (error) {
    showError(error);
  } finally {
    setTrustBusy(false);
  }
}

async function untrustSite(): Promise<void> {
  const site = currentSite;
  if (!site) {
    return;
  }

  setTrustBusy(true);
  try {
    await removeTrustedSite(site.pattern);
    await syncSites();
    trusted = false;
    await renderSite();

    // Revoking access is best-effort: the site is already untrusted in storage.
    await browser.permissions.remove({ origins: [site.pattern] }).catch((error) => {
      console.warn("[mathpad] could not revoke host permission", error);
    });
    await reloadActiveTab();
  } catch (error) {
    showError(error);
  } finally {
    setTrustBusy(false);
  }
}

/** Renders the trust state and, when trusted, the pairing UI. */
async function renderSite(): Promise<void> {
  if (!currentSite) {
    showUnsupportedPage();
    return;
  }

  elements.site.textContent = trusted
    ? `MathPad is on for ${currentSite.hostname}`
    : `MathPad is off for ${currentSite.hostname}`;
  setTrustButton(trusted);
  elements.trustSiteButton.hidden = trusted;
  elements.pairButton.hidden = !trusted;

  if (!trusted) {
    clearPairing();
    showMessage("Trust this site to pair and paste math into it.");
    return;
  }

  await loadPairing();
}

async function loadPairing(): Promise<void> {
  const response = (await browser.runtime.sendMessage({
    type: "getStatus",
  })) as StatusResponse | undefined;
  const status = response?.status ?? "idle";

  if (!response?.state) {
    clearPairing();
    setStatus(status);
    return;
  }
  // A stored-but-expired pairing means a stale QR: regenerate right away.
  if (status === "expired") {
    void regeneratePairing();
    return;
  }
  showPairing(response.state, status);
}

/** Starts a new pairing and puts its QR on screen. */
async function regeneratePairing(): Promise<void> {
  if (!trusted) {
    return;
  }

  refreshing = true;
  elements.pairButton.disabled = true;
  try {
    const state = await startPairing();
    // The old socket in the background is replaced via the storage listener.
    showPairing(state, "connecting");
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
    elements.pairButton.disabled = false;
  }
}

async function reloadActiveTab(): Promise<void> {
  try {
    if (currentTabId === undefined) {
      return;
    }
    await browser.tabs.reload(currentTabId);
  } catch (error) {
    showError(error);
  }
}

/** Asks the background to reconcile dynamic content-script registrations. */
async function syncSites(): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      type: "syncSites",
    } satisfies SyncSitesMessage);
  } catch (error) {
    console.warn("[mathpad] could not sync trusted sites", error);
  }
}

async function activeTab() {
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0];
}

/**
 * Reads the active tab's URL. `tabs.query` can omit it on some pages or app
 * windows, so fall back to reading it from the page with the temporary
 * `activeTab` access granted by opening this popup.
 */
async function readTabUrl(
  tab: { id?: number; url?: string } | undefined,
): Promise<string | undefined> {
  if (!tab) {
    return undefined;
  }
  if (tab.url) {
    return tab.url;
  }
  if (tab.id === undefined) {
    return undefined;
  }

  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => location.href,
    });
    return typeof result?.result === "string" ? result.result : undefined;
  } catch (error) {
    console.warn("[mathpad] could not read the active tab URL", error);
    return undefined;
  }
}

function showPairing(state: PairState, status: ConnStatus): void {
  displayedCode = state.code;

  // Prefer the server-provided https landing URL: phone cameras reliably open
  // those (then redirect into the app); a bare custom-scheme QR often just
  // gets copied to the clipboard by the camera app.
  const qrTarget = state.pair_url ?? pairUrl(state);

  elements.code.textContent = state.code;
  elements.code.hidden = false;
  elements.qr.hidden = true;
  elements.pairButton.hidden = false;
  setStatus(status);

  void QRCode.toDataURL(qrTarget, { width: QR_WIDTH_PX, margin: 1 }).then(
    (url) => {
      // Don't paint a QR for an already-replaced pairing.
      if (displayedCode !== state.code) {
        return;
      }
      elements.qr.src = url;
      elements.qr.hidden = false;
    },
    showError,
  );
}

function clearPairing(): void {
  displayedCode = undefined;
  elements.code.textContent = "";
  elements.code.hidden = true;
  elements.qr.hidden = true;
  elements.qr.removeAttribute("src");
}

function setTrustButton(trustedNow: boolean): void {
  elements.trustButton.hidden = !trustedNow;
  if (!trustedNow) {
    return;
  }

  const label = "Stop using on this site";
  elements.trustButton.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6l-8-3Z" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </svg>`;
  elements.trustButton.title = label;
  elements.trustButton.setAttribute("aria-label", label);
}

function setTrustBusy(busy: boolean): void {
  elements.trustButton.disabled = busy;
  elements.trustSiteButton.disabled = busy;
}

function showUnsupportedPage(): void {
  elements.site.textContent = "MathPad can't read this page.";
  elements.trustButton.hidden = true;
  elements.trustSiteButton.hidden = true;
  elements.pairButton.hidden = true;
  clearPairing();
  showMessage(
    "Open a regular website and check that MathPad's site access isn't blocked, then reopen this popup.",
  );
}

function setStatus(status: ConnStatus): void {
  elements.status.textContent = STATUS_TEXT[status];
}

function showMessage(message: string): void {
  elements.status.textContent = message;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[mathpad] popup error", error);
  elements.status.textContent = `Error: ${message}`;
}

function getElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`Popup element #${id} is missing or has the wrong type`);
  }
  return element;
}
