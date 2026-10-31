<img src="assets/icon.svg" width="96" alt="">

# code flower tunnel

Reach your [code flower](https://github.com/lutrarutra/codeflower-workspace) sandboxes from any
browser or phone. `codeflower client` on your machine connects out to the tunnel, you sign in to
the tunnel, and the tunnel pairs your browser with your machine.

- **End-to-end encrypted.** Browser and machine encrypt everything between them. The tunnel routes
  frames it cannot read, and a hacked tunnel or account alone gives no access.
- **EU-only routing, if you want it.** On first sign-in, `codeflower tunnel login` asks whether
  your tunnel should pass only through EU datacenters.
- **Hosted or self-hosted.** The same code runs on Cloudflare Workers or as one Node process with
  a SQLite file.

[PROTOCOL.md](PROTOCOL.md) describes what passes between tunnel, connector and browser.

## Self-hosting

```sh
docker build -t codeflower-tunnel .
docker run -d -p 8787:8787 -v codeflower-tunnel:/data \
  -e PUBLIC_URL=https://tunnel.example.org \
  -e COOKIE_SECRET="$(openssl rand -base64 48)" \
  -e GITHUB_CLIENT_ID=… -e GITHUB_CLIENT_SECRET=… \
  codeflower-tunnel
```

Put it behind a reverse proxy that terminates TLS and passes WebSockets through. Then point
connectors at it: `tunnel.url` in `~/.codeflower/config.yaml`.

| Variable | |
| --- | --- |
| `PUBLIC_URL` | where browsers reach the tunnel (required) |
| `COOKIE_SECRET` | at least 32 random characters; changing it signs everyone out (required) |
| `TUNNEL_DB` | the SQLite file (required, created if missing; `/data/tunnel.sqlite` in the image) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | enables GitHub sign-in (callback: `<PUBLIC_URL>/auth/github/callback`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | enables Google sign-in (callback: `<PUBLIC_URL>/auth/google/callback`) |
| `REQUIRE_GITHUB_2FA` | `false` admits GitHub accounts without two-factor authentication |
| `WEBAUTHN_RP_ID` | the passkeys' domain, if not `PUBLIC_URL`'s host |
| `ALLOWED_IPS` | addresses and CIDR ranges, separated by commas or spaces, e.g. `203.0.113.0/24, 2001:db8::/32`: browsers elsewhere cannot open streams (403). Unset admits all. |
| `CLIENT_IP_HEADER` | behind a reverse proxy, the header it puts the client's address in (`X-Real-IP`, or `X-Forwarded-For`, of which the last address counts). Unset uses the socket's address. Set it only when the proxy overwrites or appends to that header, or clients can forge it. |
| `PORT`, `HOST` | where to listen (8787, all interfaces) |

Passkey sign-in always works. The database migrates itself at startup. Back it up by copying
the file with `sqlite3 tunnel.sqlite ".backup backup.sqlite"`. A self-hosted tunnel is one
process; it does not scale out across machines.

## On Cloudflare

The hosted tunnel deploys from this repository with Cloudflare Workers Builds:
see [DEPLOY.md](DEPLOY.md) for the one-time setup (CI fields, secrets, OAuth
apps). Each connector gets one Durable Object, which pairs its sockets and
stores nothing. Connectors registered as EU-only (`eu_…` IDs) get theirs in the
EU jurisdiction. Accounts live in D1.

## Development

```sh
npm install
npm test             # unit tests and the self-hosted server end to end
npm run check        # TypeScript
npm run dev:node     # self-hosted on :8787, database in .dev/
npm run dev:worker   # Cloudflare locally (needs .dev.vars, see below)
```

`.dev.vars` for `wrangler dev`:

```
PUBLIC_URL=http://127.0.0.1:8787
COOKIE_SECRET=dev-secret-dev-secret-dev-secret-00
LOCAL_DEV_WITHOUT_JURISDICTIONS=true
```

Local workerd cannot place Durable Objects in a jurisdiction, hence the last line. Never set it
in production. Apply migrations to the local D1 first:
`npx wrangler d1 migrations apply codeflower-tunnel --local`.

**Releasing a breaking protocol change**: raise `PROTOCOL` in `src/version.ts`, and keep
accepting the old version while possible. To stop accepting a version, first set `DEPRECATED`
with a date, so connectors warn their users. After that date, raise `MIN_PROTOCOL`. Connectors
below it are then refused with `426 upgrade_required` and tell their users to update code flower.
See "Versioning" in [PROTOCOL.md](PROTOCOL.md).

**Changing the database**: edit `src/db/schema.ts`, run `npm run db:generate`, review and commit
the new file in `migrations/`. Both platforms apply it: Cloudflare on `npm run deploy`, self-hosted
at the next start.

## License

[AGPL-3.0](LICENSE). If you run a modified tunnel as a service, you must offer its source to its
users. For other terms, get in touch. Contributions need a signed CLA, see
[CONTRIBUTING.md](CONTRIBUTING.md). The connector (codeflower-app) and the browser side
(codeflower-ui) are MIT.
