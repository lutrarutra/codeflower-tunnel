# Traffic and abuse

What passes through the tunnel, what it can and cannot be misused for, and the limits against
that. The cryptography and the threat model are in [SECURITY.md](SECURITY.md) and
[PROTOCOL.md](PROTOCOL.md).

## What passes through

Everything the local `codeflower client` page can do also works through the tunnel, end-to-end
encrypted in frames of at most 60 kB. There are two kinds of stream:

- **HTTP requests**, replayed by the connector against the routes it allows
  (`internal/client/remote.go` in codeflower-app): the page itself (`main.js`, CSS),
  `/api/system`, `/api/resources`, the worker list and sessions, and stopping a worker. With
  `tunnel: {manage: true}` in config.yaml, also the folder browser and starting and forgetting
  sandboxes. Connecting to an address (`POST /api/workers/connect`) and quitting are never
  allowed remotely. These are small: the page once, then a few kB per call.
- **The chat WebSocket** (`/api/workers/{id}/acp`), relayed to the worker's bridge without
  filtering its methods. It carries the agent's chat and tool calls, an interactive terminal and
  shell commands, file listing, reading (up to 10 MB a file) and writing, uploads (up to 1 GB by
  default, `CODEFLOWER_UPLOAD_MAX`, sent in 1 MB chunks), transcripts, reports and usage.

The connector splits each WebSocket message into 60 kB frames and the other end reassembles
them (up to 32 MB a message). The tunnel only checks each frame's size, so a 1 GB upload is about
17,500 frames.

## What it cannot be used for

- **A proxy to other sites.** The tunnel never opens connections to other hosts. It joins a
  browser's socket to a connector's socket and nothing else. Whatever an agent in a sandbox does
  on the network leaves from the user's own machine or cluster, under its address. The tunnel's
  addresses never appear in a third party's logs.
- **Reaching other people.** A browser may open streams only to connectors of the account it is
  signed in to (`/c/:connectorId/stream` in `src/app.ts`). The tunnel cannot host pages for
  strangers or relay between accounts, so it is of no use for phishing or for sharing files with
  others.
- **Port forwarding.** The connector has no code path that connects to an address the remote side
  chooses: no port forwarding, no SOCKS. Workers are added on the machine itself.

Adding the browser's IP address to the requests would not help against abuse. The tunnel cannot
change the encrypted requests, and the only one who would see the header is the account's own
connector, i.e. the person in question.

## What it can be misused for

The app and connector are open source. With modified versions, an account holder can use the
hosted tunnel as an encrypted relay between their own machines:

- reaching a cluster past its firewall or its rules against remote access, or moving data into
  it past its controls;
- free bandwidth through Cloudflare;
- at worst, malware that embeds a connector and is controlled through the tunnel.

The tunnel cannot see the content, so the defences work on accounts and volume. The terminal is
also a remote shell into the sandbox. That is the feature, but cluster administrators will see
it as a way in that bypasses their SSH and 2FA, so the user docs say so up front and the terms
make users responsible for their institution's policies.

## Limits

In place:

| Limit | Value | Where |
| --- | --- | --- |
| Connectors per account | 20 | `MAX_CONNECTORS`, `src/app.ts` |
| Open streams per connector | 64 | `MAX_STREAMS`, `src/hub.ts` |
| Frame size | 256 kB | `MAX_FRAME`, `src/hub.ts` |
| Connector answers a new stream | within 15 s | `DIAL_BACK_MS`, `src/hub.ts` |
| Browsers | signed in as the connector's owner | `src/app.ts` |
| GitHub accounts | two-factor authentication required | `REQUIRE_GITHUB_2FA` |
| Browser addresses | only these IPs and CIDR ranges may open streams, if set (unknown addresses are refused) | `ALLOWED_IPS`, `src/ip.ts` |

`ALLOWED_IPS` suits a self-hosted tunnel for one institution (its network or VPN ranges). It
applies to every account on the tunnel, so the hosted tunnel leaves it unset. It takes addresses
and CIDR ranges, IPv4 and IPv6, separated by commas or spaces; a bad entry stops the tunnel at
startup. Browsers elsewhere get `403 {"error": "address_not_allowed"}` when they open a stream.
Only streams are checked: the sign-in and account pages stay reachable, but without a stream they
reach nothing on the user's machine. Behind a reverse proxy, `CLIENT_IP_HEADER` names the header
that carries the client's address (`X-Real-IP`, or `X-Forwarded-For`, of which the last address
counts, because clients can forge the ones before it). Set it only when the proxy overwrites or
appends to that header.

**Telling the owner.** When a browser opens a stream, the tunnel passes its address to the
connector in the `open` message on the control socket (`"ip"`, see `src/hub.ts` and
[PROTOCOL.md](PROTOCOL.md)): `CF-Connecting-IP` on Cloudflare, the socket's address or
`CLIENT_IP_HEADER` when self-hosted. The app's notice then says "Phone connected from
203.0.113.4" (`announce` in codeflower-app's `internal/tunnel/connector.go`), and the connector's
log says the same. It tells the user again at once when a device connects from a new address,
and otherwise at most hourly per device. The tunnel is not trusted, so the address is information,
not a check: the connector shows it only if it parses as an IP address, and never admits or
refuses anything by it. It helps users notice a stolen device.

Planned for the paid launch:

- **Paid accounts.** Payment ties an account to a real identity, which matters more than any
  technical limit. Keep any free tier small.
- **A byte-rate limit per stream** in the hub (a token bucket of a few MB/s), and **a monthly
  transfer quota per account**, counted in the Durable Object. Over the quota, remote uploads fail
  with a clear message ("monthly tunnel transfer used up"); the local page is unaffected. Traffic
  costs little (see [costs.md](costs.md)), so the quota is about fairness and not standing out to
  Cloudflare.
- **A connection log**: per stream the account, connector, browser and connector IP
  (`CF-Connecting-IP`), start, end and bytes, kept 7 to 30 days. It answers abuse reports and
  lawful requests without any content, and feeds the quota. Short-lived security logs are
  allowed under GDPR as a legitimate interest; the privacy policy names them.
- **Acting on reports**: an acceptable use policy in the terms, an `abuse@` address, Cloudflare
  rate limiting on sign-up and sign-in, and an admin command that suspends an account and revokes
  its connectors (revoking already closes all of a connector's sockets).
- **Optionally, a remote-terminal switch**, like `manage`, for institutions that allow remote
  chat but not a remote shell.
