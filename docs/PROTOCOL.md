# Tunnel protocol, version 1

Three parties: the **tunnel** (this server), a **connector** (`codeflower client` on the user's
machine, Go) and a **browser**. The tunnel authenticates both ends and pairs their WebSockets.
It never sees plaintext: everything on a stream is end-to-end encrypted between browser and
connector (see [End-to-end layer](#end-to-end-layer)).

All paths are relative to the tunnel's `PUBLIC_URL`.

## Connector registration (device flow)

1. `POST /api/device/code` with `{"name": "laptop", "region": "eu" | "any", "publicKey": "<b64url X25519>"}`
   → `{"deviceCode", "userCode", "verificationUrl", "interval", "expiresIn"}`.
   The connector shows `userCode` and `verificationUrl` (`/device?code=ABCD-EFGH`).
2. The user, signed in, opens the URL and approves (`POST /api/device/approve {"userCode"}`) or
   denies (`POST /api/device/deny {"userCode"}`).
3. The connector polls `POST /api/device/token {"deviceCode"}` every `interval` seconds:
   - `400 {"error": "authorization_pending"}`: keep polling
   - `400 {"error": "access_denied" | "expired_token"}`: stop
   - `200 {"connectorId", "token"}`: done. The code works once.

`region` is the user's answer to the EU-only question. It becomes part of the ID: `eu_…` for EU
connectors, whose streams the hosted tunnel routes only through EU datacenters. A self-hosted
tunnel accepts the prefix and ignores it.

The token is a bearer secret. The tunnel stores only its SHA-256 hash. Revoking the connector
(`DELETE /api/connectors/{id}`, by its owner) invalidates the token and closes its sockets.

## Sockets

All three are WebSockets. Connectors authenticate with `Authorization: Bearer <token>`. Browsers
authenticate with the session cookie, and the tunnel refuses any `Origin` other than its own.

| Path | Who | Purpose |
| --- | --- | --- |
| `GET /connect` | connector | control socket, one per connector (a new one replaces the old, which is closed with 4000) |
| `GET /connect/streams/{stream}` | connector | the connector's end of a stream |
| `GET /c/{connectorId}/stream` | browser | opens a stream to the connector |

Opening a stream:

1. The browser opens `/c/{connectorId}/stream`. The tunnel picks a stream ID and sends
   `{"type":"open","stream":"<id>","ip":"203.0.113.4"}` (text) on the connector's control socket.
   `ip` is the browser's address as the tunnel sees it (IPv4-mapped IPv6 addresses written as
   IPv4), left out when unknown. Connectors show it when a device connects; they must not rely
   on it, since only the tunnel vouches for it.
2. The connector dials `/connect/streams/<id>` within 15 s.
3. The tunnel sends the browser one text frame, `{"type":"ready"}`. From then on, each binary frame
   from one end is delivered unchanged to the other. Endpoints send only binary frames on streams.
4. Closing either end closes the other with the same code.

A tunnel with an allowlist (`ALLOWED_IPS`) answers browsers from other addresses `403
{"error": "address_not_allowed"}` instead of opening the stream.

The control socket answers the text frame `ping` with `pong` (connectors send it every 30 s).
A control socket without a `ping` for 90 s is closed with 4408: a computer that sleeps or loses
its network sends no close. The connector's last seen time is when its control socket closed, or
for one closed that way, its last `ping`.
The only other frame a connector sends on it is its status, `{"type":"status","sandboxes":2}`
(text): how many sandboxes it runs that paired browsers may reach, when it connects and whenever
that changes. The tunnel keeps it with the socket, not in its database, to show the account page's
connectors with their sandboxes; it ignores anything else, and tunnels from before the status
ignore it too, so it needs no new protocol version.

Limits: binary frames up to 256 KiB, 64 open streams per connector. Close codes:

| Code | Meaning |
| --- | --- |
| 4000 | replaced by a newer control socket |
| 4401 | not authorized, or the connector was revoked |
| 4404 | the connector is offline |
| 4408 | the connector did not dial back in time, or its control socket stopped pinging |
| 4429 | too many open streams |
| 1003 | a text frame was sent on a stream |
| 1009 | a frame was too large |

## Versioning

The protocol has an integer version, now **1**. Connectors send theirs with every request and
socket: `Codeflower-Tunnel-Protocol: 1`. A tunnel accepts a range of versions (`src/version.ts`):

- `GET /api/version` → `{"protocol": 1, "minProtocol": 1, "deprecated": null | {"below": 1, "after": "2027-03-01"}}`.
  No sign-in needed. Connectors call it when they start and every time they reconnect.
- Version below `minProtocol`, or no header: `426 {"error": "upgrade_required", "message", "protocol", "minProtocol"}`.
- Version above `protocol` (a self-hosted tunnel older than the app): `400 {"error": "tunnel_too_old", …}`.

What the connector does with each answer:

| Answer | Connector |
| --- | --- |
| `upgrade_required` | stops reconnecting and tells the user to update code flower (desktop notification, the client page, and `codeflower tunnel status`). It retries only after an app update or when the user asks. |
| `deprecated` covers its version | keeps working, and warns once a day that it must be updated before `after` |
| `tunnel_too_old` | stops reconnecting and says the tunnel's operator must update it |

Shipping a tunnel release:

- Non-breaking changes keep `protocol` as is.
- A breaking change raises `protocol` and keeps the old version working while possible.
- To drop a version, first set `deprecated` for it, with a date. After that date, raise
  `minProtocol`.

Deploying restarts the Durable Objects, which closes every socket. Connectors reconnect, and
those below `minProtocol` get the 426 at once.

## End-to-end layer

Between browser and connector only; the tunnel passes the frames on. Implemented
in codeflower-app (`internal/tunnel`, on flynn/noise) and codeflower-ui
(`src/tunnel`). Their tests share fixed vectors (`noise-vectors.json`), so both
produce the same bytes.

### Keys and pairing

- The connector and each browser have a static X25519 key pair. Keys travel as
  unpadded base64url.
- **Fingerprint** of a key: SHA-256 of its base64url text, first 16 hex digits,
  in groups of four (`1a2b 3c4d 5e6f 7a8b`). The CLI, the account page and the
  pairing page show it.
- `codeflower tunnel pair` writes a one-time secret (valid 10 minutes, stored
  hashed) and prints `<tunnel>/p#<connectorId>.<connectorKey>.<secret>`. The
  fragment never reaches the tunnel. The pairing page takes it from the address,
  removes it, shows the connector key's fingerprint, and opens a stream with the
  secret in its hello. The connector then adds the browser's static key to its
  paired devices, and the secret is used up.
- From then on, the connector accepts the browser by its static key alone. It
  refuses unknown keys, and revoking a device (`codeflower tunnel revoke`)
  closes its open streams.

### Handshake

`Noise_IK_25519_ChaChaPoly_SHA256`. The browser is the initiator and knows the
connector's static key from pairing. The prologue is the UTF-8 text
`codeflower-tunnel/1 <connectorId>`.

1. Browser → connector, the first binary frame after `ready`: message 1
   (`e, es, s, ss`). Its payload is JSON:
   `{"v": 1, "pair": "<secret>"?, "device": "<name>"?}`.
2. Connector → browser: message 2 (`e, ee, se`). Its payload is JSON: `{"v": 1}`,
   or `{"v": 1, "error": "not_paired" | "pairing_expired" | "off"}`, after which
   the connector closes the stream. A browser that cannot complete the handshake
   is talking to another key and must stop.

After the handshake, each binary frame is one Noise transport message: at most
65535 bytes, with nonces counting messages. A dropped, repeated or reordered
frame fails to decrypt and ends the stream.

### Envelope

The plaintext of each transport message is one kind byte, then data:

| Kind | Direction | Data |
| --- | --- | --- |
| 1 open | browser → | JSON `{"kind": "http" \| "ws", "method"?, "path", "headers"?}`, the first message |
| 2 head | → browser | JSON `{"status", "headers"}` (HTTP) |
| 3 data | both | a chunk of an HTTP body, at most 60000 bytes |
| 4 end | both | the end of an HTTP body |
| 5 text, 6 binary | both | a WebSocket message, or its last part |
| 9 text part, 10 binary part | both | a part of a longer WebSocket message (up to 32 MiB in all) |
| 7 close | both | JSON `{"code", "reason"?}`: closes the WebSocket, or refuses the request |
| 8 accepted | → browser | the WebSocket is open |

An HTTP stream carries `open`, `data`…, `end` one way and `head`, `data`…, `end`
the other, then closes. A WebSocket stream (only `/api/workers/{id}/acp`, a chat)
carries `open`, then `accepted` or `close`, then messages both ways. The
connector closes chats after 30 idle minutes.

The connector passes requests to `codeflower client`, which serves remote
browsers less than its local page (see codeflower-app's `internal/client/remote.go`).

### Pages

The tunnel serves the browser code from codeflower-ui's tunnel build (copied with
`npm run vendor-ui`; hashes in `ui-hashes.json`, checked by
`codeflower tunnel verify`):

- `/p`: the pairing page.
- `/m/<connectorId>/`: the bootstrap. It installs the service worker (`/sw.js`,
  scope `/m/`), which fetches everything under `/m/<connectorId>/` from the
  connector through encrypted streams. So the app's page and its code come from
  the user's computer. Chats open their own streams, because service workers
  cannot intercept WebSockets.
- The page shows the sandboxes of every computer the browser is paired with: it
  reads the pairings from IndexedDB, joins them with `GET /api/connectors` for
  names and whether each is online, and asks each computer under its own
  `/m/<connectorId>/api/…`. As it loads, it moves once to the page of the
  online computer whose app is newest (`pageApi`, then `version`, in its
  `/api/system`).
- The service worker keeps the page's code (`*.js`, `*.css`, `assets/…`) in a
  cache per connector and build: `index.html` names its build
  (`<meta name="codeflower-build">`), and a new build replaces the cache, so a
  reload asks the connector only for `index.html`. When a computer cannot be
  reached, its error page links to the page from the other online computers.

## Connector endpoints

With the connector's bearer token and the protocol header:

- `PUT /api/connector/key {"publicKey"}`: the new key after `codeflower tunnel rotate`.
- `DELETE /api/connector`: removes the connector (`codeflower tunnel logout`).
