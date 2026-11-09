/** Connection states the popup can display. */
export type ConnStatus =
  | "idle" // no pairing stored yet
  | "connecting" // ws not open yet
  | "listening" // ws open, waiting for phone
  | "paired" // at least one text received successfully
  | "expired"; // server no longer has this pairing (server restart)
