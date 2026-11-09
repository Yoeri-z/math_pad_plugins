import { API_HTTP } from "./config.ts";
import type { PairState } from "./types.ts";

interface PairResponse {
  code: string;
  token: string;
  pair_url?: string;
}

/** Asks the server for a new pairing session (code is shown as a QR). */
export async function createPairingRequest(): Promise<PairState> {
  const response = await fetch(`${API_HTTP}/api/pair`, { method: "POST" });
  if (!response.ok) {
    throw pairingError(`HTTP ${response.status}`);
  }

  const pairing = parsePairResponse(await response.json());
  return {
    code: pairing.code,
    token: pairing.token,
    pair_url: pairing.pair_url,
  };
}

/** Server status URL for a pairing (also doubles as an auth probe). */
export function pairStatusUrl(state: PairState): string {
  const query = new URLSearchParams({
    code: state.code,
    token: state.token,
  });
  return `${API_HTTP}/api/pair/status?${query}`;
}

function parsePairResponse(value: unknown): PairResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw pairingError("malformed server response");
  }

  const { code, token, pair_url } = value as Record<string, unknown>;
  if (typeof code !== "string" || code.length === 0) {
    throw pairingError("malformed server response");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw pairingError("malformed server response");
  }
  if (pair_url !== undefined && typeof pair_url !== "string") {
    throw pairingError("malformed server response");
  }

  return { code, token, pair_url };
}

function pairingError(reason: string): Error {
  return new Error(`pairing request failed: ${reason}`);
}
