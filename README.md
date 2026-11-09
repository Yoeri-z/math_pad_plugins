# MathPad plugin API

This document is the public, versioned contract for anything that connects to
the MathPad server **as a plugin**. A plugin is any client that pairs with a
phone and receives what the user sends from it: a browser extension, a desktop
app, an editor integration, a clipboard daemon, and so on.

It covers the three things a plugin consumes:

1. Pairing over HTTP, including the QR payload.
2. The plugin WebSocket connection.
3. Server-to-plugin messages: text datatypes and images.

Phone/app-facing endpoints are deliberately **not** documented here. They are
internal, can change at any time, and no plugin should call them.

The reference implementation lives in [`browser/`](./browser), a browser
extension built with WXT. `browser/lib/protocol.ts` is the canonical client-side
parser for the wire contract.

---

## Versioning

The current contract is **version 1**.

- Every WebSocket message carries `"version": 1`.
- Plugins must reject messages whose `version` they do not support.
- New **datatypes** are additive and do not require a protocol version bump.
- New envelope fields are additive. Receivers must ignore unknown fields.
- Breaking changes to the envelope bump the version.

Treat every server message as untrusted input. Validate it before using it.

---

## Pairing and QR flow

Pairing is a short-lived handshake between one plugin installation and one
phone. The plugin creates the pairing, displays a QR code, and keeps polling
until the phone claims it.

```text
Plugin                            Server                        Phone
    |                               |                              |
    |-- POST /api/pair ------------>|                              |
    |<-- {code, token, pair_url} ---|                              |
    |                               |<---- scans QR, claims -------|
    |-- GET /api/pair/status ------>|                              |
    |<-- {claimed: true, ...} ------|                              |
    |-- GET /ws?code=&token= ------>|                              |
    |<== text / image messages =====|                              |
```

The QR code is not itself part of the wire contract. Only the URL/content
encoded in the QR is.

### `POST /api/pair`

Creates a fresh pairing. No request body or authentication is required.

Response `200`:

```json
{
  "code": "abc123",
  "token": "opaque-secret",
  "pair_url": "https://server.example/pair?code=abc123&token=opaque-secret"
}
```

| Field      | Type   | Meaning                                                     |
| ---------- | ------ | ----------------------------------------------------------- |
| `code`     | string | Short public pairing identifier. Safe to display.           |
| `token`    | string | Secret credential. Store it; never log or share it.         |
| `pair_url` | string | URL to encode in the QR. Opens the server's pairing page.   |

`pair_url` is optional for older servers. If it is absent, encode this deep
link instead:

```text
mathpad://pair?code=<url-encoded code>&token=<url-encoded token>
```

Prefer `pair_url` when present: phone cameras reliably open HTTPS links and the
landing page redirects into the app. A bare `mathpad://` QR is the fallback.

Creating a pairing replaces the previous one. The plugin must close its old
socket and open a new one with the new credentials.

Errors use the standard error body:

```json
{ "error": "human-readable message" }
```

### `GET /api/pair/status?code=<code>&token=<token>`

Reports whether the phone has claimed the pairing and whether a plugin socket
is currently linked.

Response `200`:

```json
{ "claimed": true, "linked": true }
```

| Field     | Type    | Meaning                                                   |
| --------- | ------- | --------------------------------------------------------- |
| `claimed` | boolean | A phone has claimed this pairing.                         |
| `linked`  | boolean | The server currently has a plugin socket for it.          |

Use `claimed` to update UI after the QR is scanned. The endpoint also doubles
as an authentication probe: `401 Unauthorized` means the code/token no longer
match a live pairing (for example after a server restart).

Pairings are held in memory. A server restart invalidates every existing
pairing. Treat `401` as `expired` and generate a new QR.

---

## WebSocket connection

### `GET /ws?code=<code>&token=<token>`

Upgrades to a WebSocket using the same credentials as the status endpoint.
Use `ws://` in local development and `wss://` in production.

Authentication happens **before** the upgrade:

- Invalid or expired credentials return HTTP `401` with a JSON error body and
  no WebSocket.
- Successful upgrade returns `101 Switching Protocols`.

After connecting, the server pushes messages to the plugin. The plugin does not
need to send anything to receive messages. Any frames sent by the plugin are
currently ignored; the browser plugin sends a periodic `ping` only to keep its
MV3 service worker alive.

### WebSocket rules

- Every server frame is a **text** frame exactly as described below.
- One frame is exactly one JSON object. Do not batch arrays.
- The server may send any supported datatype on the same socket.
- A malformed or unsupported frame must be logged and dropped. It does not
  close the socket by itself.
- Plugins must tolerate unknown JSON fields.

---

## Message envelope

Every server-to-plugin message has this shape:

```json
{
  "version": 1,
  "id": "msg_4f8c2a...",
  "datatype": "latex",
  "sent_at": "2025-01-01T12:00:00Z",
  "payload": "x^2 + y^2"
}
```

| Field      | Type   | Rules                                                                 |
| ---------- | ------ | --------------------------------------------------------------------- |
| `version`  | number | Must be `1`.                                                          |
| `id`       | string | 1-128 chars of `A-Z a-z 0-9 . _ : -`. Unique per message.            |
| `datatype` | string | Lowercase. Pattern `name` or `name/subtype`. Selects payload rules.   |
| `sent_at`  | string | RFC 3339 timestamp.                                                   |
| `payload`  | string | Always a string. The datatype defines how to interpret it.            |

The payload is intentionally not a nested object. Text and image data both fit
in one uniform field, and the `datatype` decides what the string means.

---

## Datatypes

| `datatype`  | Payload                          | Meaning                                      |
| ----------- | -------------------------------- | -------------------------------------------- |
| `plaintext` | UTF-8 text                       | Unformatted text.                            |
| `latex`     | UTF-8 LaTeX source               | Text intended to be inserted as LaTeX.       |
| `smiles`    | UTF-8 SMILES string              | Molecular structure notation.                |
| `tikz`      | UTF-8 TikZ source                | Text intended to be inserted as TikZ.        |
| `image/png` | Single-line base64 PNG bytes     | Raster image.                                |

The set is open. Future text-like datatypes use the same string payload rules.
Future image datatypes use `image/<subtype>` and the same base64 rules.

### Text datatypes: `plaintext`, `latex`, `smiles`, `tikz`

Rules:

- `payload` is the text itself, encoded as JSON string.
- It must not be empty or whitespace-only.
- Preserve the string exactly. Do not trim, re-wrap, or append separators.
- Newlines and Unicode are allowed.
- The datatype is a hint for how the text was produced. The reference plugin
  inserts all text datatypes at the caret as text. Specialized plugins may
  render `latex`, `smiles`, or `tikz` differently.
- Unknown text-like datatypes are not inserted automatically. Ignore them.

Example:

```json
{
  "version": 1,
  "id": "msg_01J8Y6A0B1C2D3E4F5G6H7J8K9",
  "datatype": "latex",
  "sent_at": "2025-01-01T12:00:00Z",
  "payload": "\\frac{a}{b}"
}
```

### Image datatypes: `image/<subtype>`

Rules:

- `datatype` must start with `image/` followed by a lowercase subtype, for
  example `image/png`.
- `payload` is **single-line standard base64** of the raw image bytes.
- Do not send a data URL (`data:image/png;base64,...`), whitespace, or line
  breaks.
- The decoded image must be at most **8 MiB** (`8 * 1024 * 1024` bytes).
- The server currently sends `image/png`. Plugins should accept any `image/*`
  datatype they know how to handle.
- Invalid base64 or an oversized image must be rejected without attempting to
  render or insert it.

Example:

```json
{
  "version": 1,
  "id": "msg_01J8Y6A0B1C2D3E4F5G6H7J8K9",
  "datatype": "image/png",
  "sent_at": "2025-01-01T12:00:00Z",
  "payload": "iVBORw0KGgoAAAANSUhEUg..."
}
```

How a plugin surfaces an image is implementation-specific. The browser plugin
activates only on sites the user has explicitly trusted, then pastes the image
at the caret of the focused editor, just like a normal clipboard paste. Images
are not inserted into ordinary text fields.

### Unknown datatypes

If a message has a well-formed envelope but a datatype the plugin does not
know:

1. Log it for diagnostics.
2. Drop it.
3. Keep the socket open.

Never guess at an unknown payload shape or insert it as text.

---

## Error handling and reconnection

Recommended plugin behavior:

- **Malformed frame** (`bad JSON`, missing fields, wrong types): log, drop,
  continue listening.
- **Unsupported version**: log and drop. Do not interpret the frame.
- **Unsupported datatype**: log, drop, continue listening.
- **Socket closes**: reconnect with exponential backoff.
- **Status returns `401`**: the pairing is gone. Stop reconnecting, mark the
  pairing expired, and create a new one.
- **Status returns `claimed: false`**: the QR is still waiting for a phone.
- **Status returns `claimed: true`**: update the UI; keep the socket open.

The browser plugin uses:

- 1 second initial reconnect delay, doubling to a 30 second cap.
- A status poll every 2 seconds while waiting for a claim.
- A 20 second WebSocket ping to keep its MV3 service worker alive.

The server never promises delivery of a message that was sent while the plugin
was disconnected. Pairings are also dropped after inactivity; a subsequent
`401` means the plugin must pair again.

---

## Reference implementation

The browser plugin in [`browser/`](./browser) is one concrete consumer of this
contract. Useful entry points:

| File                            | Responsibility                                      |
| ------------------------------- | --------------------------------------------------- |
| `browser/lib/protocol.ts`       | Envelope types, validation, and frame parser.       |
| `browser/lib/insert.ts`         | Inserts text and pastes images at the caret.         |
| `browser/lib/trusted-sites.ts`  | User-trusted sites, permissions, and registration.   |
| `browser/lib/api.ts`            | `POST /api/pair` and status URL construction.       |
| `browser/lib/pairing.ts`        | Stored pairing state and QR/deep-link generation.   |
| `browser/lib/messages.ts`       | Internal background/content-script messages.        |
| `browser/entrypoints/background.ts` | WebSocket lifecycle, polling, site-gated relay. |
| `browser/entrypoints/trusted.ts`    | Content script injected into trusted sites.     |
| `browser/test/protocol.test.ts`     | Wire-contract parser tests.                        |
| `browser/test/trusted-sites.test.ts` | Trusted-site storage and URL validation tests.    |

MathPad starts with **no site access**. The popup asks the browser for host
permission only when the user presses “Trust this site”; it then stores the site
and registers the content script dynamically for that origin. The current tab
reloads once so the registered script activates. Removing trust revokes the
permission and unregisters the script. There are no static host permissions for
websites.

Run the plugin contract tests from `browser/` with:

```bash
npm test
npm run compile
```

Other plugins should implement the same pieces in their host's idiom: a pairing
store, a socket lifecycle with backoff, a validating frame parser, and one
handler per datatype.

---

## Adding a datatype

Adding a new datatype is intentionally cheap:

1. Choose a lowercase name (`asciimath`) or `image/<subtype>` (`image/jpeg`).
2. Define how the string payload maps to real content.
3. Implement send and receive support.
4. Add it to this table.
5. Add parser tests for valid, empty, and malformed payloads.

Do not change the envelope shape for a new datatype. Do not overload an
existing datatype with a different payload shape. If a plugin does not
understand the new datatype yet, it will safely ignore it.
