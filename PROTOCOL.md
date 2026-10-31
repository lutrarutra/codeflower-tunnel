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
   `{"type":"open","stream":"<id>"}` (text) on the connector's control socket.
2. The connector dials `/connect/streams/<id>` within 15 s.
3. The tunnel sends the browser one text frame, `{"type":"ready"}`. From then on, each binary frame
   from one end is delivered unchanged to the other. Endpoints send only binary frames on streams.
4. Closing either end closes the other with the same code.

The control socket answers the text frame `ping` with `pong` (connectors send it every 30 s).
Nothing else is sent to the tunnel on the control socket.

Limits: binary frames up to 256 KiB, 64 open streams per connector. Close codes:

| Code | Meaning |
| --- | --- |
| 4000 | replaced by a newer control socket |
| 4401 | not authorized, or the connector was revoked |
| 4404 | the connector is offline |
| 4408 | the connector did not dial back in time |
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

Specified with the connector and browser implementations (codeflower-app and codeflower-ui):
Noise `IK` (`Noise_IK_25519_ChaChaPoly_SHA256`) per stream, the browser knowing the connector's
static key from pairing, then a request envelope (`http` or `ws`). The tunnel is not involved.
