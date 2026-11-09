/** One site the user explicitly trusts MathPad on. */
export interface TrustedSite {
  /** Hostname shown in the popup. */
  hostname: string;
  /** Match pattern used for the host permission and content script. */
  pattern: string;
}

/** Storage key for the user's trusted-site list. */
export const TRUSTED_SITES_KEY = "trustedSites";

/** Bundled content script, referenced by the dynamic registration. */
const CONTENT_SCRIPT_FILE = "trusted.js";

const PATTERN_PATTERN = /^https?:\/\/[^\s/*]+\/\*$/;
const SCRIPT_ID_PREFIX = "mathpad_";

/**
 * The site for a page URL, or undefined for pages MathPad cannot run on.
 * Match patterns cannot contain ports, so the pattern always omits one.
 */
export function siteFromUrl(href: string): TrustedSite | undefined {
  const url = parseUrl(href);
  if (!url || !isWebUrl(url)) {
    return undefined;
  }
  return {
    hostname: url.hostname,
    pattern: `${url.protocol}//${url.hostname}/*`,
  };
}

/** Validates a persisted trusted-site list, dropping duplicates and junk. */
export function parseTrustedSites(value: unknown): readonly TrustedSite[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sites = new Map<string, TrustedSite>();
  for (const entry of value) {
    if (isValidTrustedSite(entry)) {
      sites.set(entry.pattern, entry);
    }
  }
  return [...sites.values()];
}

/** True when the site's exact pattern is already trusted. */
export function isTrustedSite(
  sites: readonly TrustedSite[],
  site: TrustedSite,
): boolean {
  return sites.some((trusted) => trusted.pattern === site.pattern);
}

export async function loadTrustedSites(): Promise<readonly TrustedSite[]> {
  try {
    const stored = await browser.storage.local.get(TRUSTED_SITES_KEY);
    return parseTrustedSites(stored[TRUSTED_SITES_KEY]);
  } catch (error) {
    console.warn("[mathpad] could not load trusted sites", error);
    return [];
  }
}

export async function addTrustedSite(site: TrustedSite): Promise<void> {
  const sites = await loadTrustedSites();
  await saveTrustedSites([...sites, site]);
}

export async function removeTrustedSite(pattern: string): Promise<void> {
  const sites = await loadTrustedSites();
  await saveTrustedSites(sites.filter((site) => site.pattern !== pattern));
}

/** True when the extension currently has host access to the site. */
export async function hasHostPermission(pattern: string): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [pattern] });
  } catch (error) {
    console.warn(`[mathpad] could not check host permission for ${pattern}`, error);
    return false;
  }
}

let syncQueue: Promise<void> = Promise.resolve();

/**
 * Reconciles dynamically registered content scripts with the trusted-site
 * list. Calls are serialized so a trust change cannot race a startup sync.
 */
export function syncContentScripts(): Promise<void> {
  syncQueue = syncQueue.then(runSync, runSync);
  return syncQueue;
}

async function runSync(): Promise<void> {
  const sites = await loadTrustedSites();
  await unregisterOwnedScripts();
  for (const [index, site] of sites.entries()) {
    await registerSite(index, site);
  }
}

async function unregisterOwnedScripts(): Promise<void> {
  try {
    const scripts = await browser.scripting.getRegisteredContentScripts();
    const ids = scripts
      .filter((script) => script.id?.startsWith(SCRIPT_ID_PREFIX))
      .map((script) => script.id as string);
    if (ids.length === 0) {
      return;
    }
    await browser.scripting.unregisterContentScripts({ ids });
  } catch (error) {
    console.warn("[mathpad] could not reset registered content scripts", error);
  }
}

async function registerSite(index: number, site: TrustedSite): Promise<void> {
  if (!(await hasHostPermission(site.pattern))) {
    console.warn(`[mathpad] no host permission for ${site.hostname}; skipping`);
    return;
  }

  try {
    await browser.scripting.registerContentScripts([
      {
        id: `${SCRIPT_ID_PREFIX}${index}`,
        matches: [site.pattern],
        js: [CONTENT_SCRIPT_FILE],
        runAt: "document_idle",
      },
    ]);
  } catch (error) {
    console.warn(
      `[mathpad] could not register the content script for ${site.hostname}`,
      error,
    );
  }
}

async function saveTrustedSites(sites: readonly TrustedSite[]): Promise<void> {
  const unique = parseTrustedSites(sites);
  await browser.storage.local.set({ [TRUSTED_SITES_KEY]: unique });
}

function isValidTrustedSite(value: unknown): value is TrustedSite {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.hostname !== "string" || value.hostname.length === 0) {
    return false;
  }
  return typeof value.pattern === "string" && PATTERN_PATTERN.test(value.pattern);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseUrl(href: string): URL | undefined {
  try {
    return new URL(href);
  } catch {
    return undefined;
  }
}

function isWebUrl(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}
