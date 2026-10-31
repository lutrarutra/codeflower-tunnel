# Deploying the hosted tunnel (tunnels.codeflower.app)

How the hosted tunnel runs on Cloudflare, deployed by Cloudflare Workers Builds
from this repository. Self-hosting is in the [README](README.md). What it costs and what
Cloudflare's terms say: [docs/costs.md](docs/costs.md).

## Already done

- The D1 database `codeflower-tunnel` exists in the EU jurisdiction. Its ID is
  in `wrangler.toml`, and migration `0000_init` is applied.
- `wrangler.toml` serves the Worker on `tunnels.codeflower.app` only, with
  `workers.dev` off. This needs `codeflower.app` as a zone in the same Cloudflare
  account.

## 1. Connect the repository (once)

Cloudflare dashboard → Workers & Pages → Create → Import a repository →
`lutrarutra/codeflower-tunnel`, then:

| Field | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `npm test` (dependencies are installed automatically; clear it if the build image cannot compile `better-sqlite3`) |
| Deploy command | `npm run deploy` (not the default `npx wrangler deploy`: `npm run deploy` applies new D1 migrations first) |
| Build variables | none (`.node-version` selects Node 22) |
| API token | none: Workers Builds creates its own. If the migration step fails with an authorization error, give that token D1 Edit. |

No GitHub Actions workflow is needed: every push to `main` builds, migrates and deploys.

## 2. Secrets (once)

Worker → Settings → Variables and Secrets → Add, type **Secret**. Plain-text
variables set in the dashboard are replaced by `wrangler.toml` on each deploy,
but secrets are kept.

| Name | Value |
| --- | --- |
| `COOKIE_SECRET` | **required**. Make one: `openssl rand -base64 48`. It signs login cookies; changing it signs everyone out. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | optional, for "Sign in with GitHub" (see below) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional, for "Sign in with Google" (see below) |

`PUBLIC_URL` is set in `wrangler.toml`, not here. Passkey sign-in works without
either provider.

Or from a terminal signed in with `wrangler login`:

```sh
openssl rand -base64 48 | npx wrangler secret put COOKIE_SECRET
```

## 3. OAuth apps (optional)

**GitHub**: github.com → Settings → Developer settings → OAuth Apps → New OAuth App:

- Homepage URL: `https://tunnels.codeflower.app`
- Authorization callback URL: `https://tunnels.codeflower.app/auth/github/callback`

Then generate a client secret, and put the Client ID and secret into the two `GITHUB_…` secrets.
Accounts without two-factor authentication are refused (`REQUIRE_GITHUB_2FA`).

**Google**: console.cloud.google.com → APIs & Services → OAuth consent screen
(External, scopes `openid` and `profile`), then Credentials → Create
credentials → OAuth client ID → Web application:

- Authorized redirect URI: `https://tunnels.codeflower.app/auth/google/callback`

Put the client ID and secret into the two `GOOGLE_…` secrets.

## 4. Check

- `https://tunnels.codeflower.app/api/version` answers `{"protocol":1,…}`.
- The front page offers the sign-in methods you configured.
- `codeflower tunnel login`, then `codeflower tunnel pair`, works end to end.
- `codeflower tunnel verify` reports `ok` for every bootstrap file.

## Releasing

- Push to `main`.
- Database changes: new migrations only (add, don't drop or rename in the same release).
- Breaking protocol changes: see "Versioning" in [PROTOCOL.md](PROTOCOL.md).
- Changing the domain invalidates all passkeys (they are bound to it).
