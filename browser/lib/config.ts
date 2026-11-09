/** Base URL of the MathPad server. TODO: make configurable via an options page. */
const SERVER_URL = "http://localhost:8080";

/** HTTP API base URL. */
export const API_HTTP = SERVER_URL;

/** WebSocket endpoint used to stream payloads from the phone. */
export const API_WS = `${SERVER_URL.replace(/^http/, "ws")}/ws`;
