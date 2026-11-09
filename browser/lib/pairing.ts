import { createPairingRequest } from "./api.ts";
import type { PairState } from "./types.ts";

interface StoredPairing {
  code?: unknown;
  token?: unknown;
  pair_url?: unknown;
}

/** Reads the stored pair state, or undefined when not paired. */
export async function loadPairState(): Promise<PairState | undefined> {
  const stored = (await browser.storage.local.get([
    "code",
    "token",
    "pair_url",
  ])) as StoredPairing;

  if (
    typeof stored.code !== "string" ||
    stored.code.length === 0 ||
    typeof stored.token !== "string" ||
    stored.token.length === 0
  ) {
    return undefined;
  }

  return {
    code: stored.code,
    token: stored.token,
    pair_url: typeof stored.pair_url === "string" ? stored.pair_url : undefined,
  };
}

/**
 * Creates a new pairing session on the server and stores it.
 * A fresh session replaces any remembered one.
 */
export async function startPairing(): Promise<PairState> {
  const state = await createPairingRequest();
  await browser.storage.local.set(state);
  return state;
}

/** Builds the deep link the phone opens when scanning the QR. */
export function pairUrl(state: PairState): string {
  const code = encodeURIComponent(state.code);
  const token = encodeURIComponent(state.token);
  return `mathpad://pair?code=${code}&token=${token}`;
}
