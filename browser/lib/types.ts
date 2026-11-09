export interface PairState {
  /** Short code shown on the QR the phone scans. */
  code: string;
  /** Secret stored by each side to recognize the pairing. */
  token: string;
  /**
   * HTTPS landing URL (see the server's `/pair` route) that opens the app after
   * the redirect. Optional for pairings stored before this field existed.
   */
  pair_url?: string;
}
