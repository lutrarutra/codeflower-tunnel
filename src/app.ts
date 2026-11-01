// The tunnel's routes, the same on Cloudflare and self-hosted: the platform
// passes in the database and the rendezvous. See docs/PROTOCOL.md.

import { and, eq, lt } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { authRoutes } from './auth.ts';
import type { Config } from './config.ts';
import { inRanges, normalizeAddress } from './ip.ts';
import { fromBase64url, randomId, randomToken, sha256Hex, userCode } from './crypto.ts';
import { schema, type Db } from './db/index.ts';
import { connectorId, type Region, type Rendezvous } from './rendezvous.ts';
import { sessionUser, signOut } from './session.ts';
import { requireProtocol, versionInfo } from './version.ts';

export const DEVICE_CODE_SECONDS = 600;
export const MAX_CONNECTORS = 20;

export interface Platform {
  config: Config;
  db(c: Context): Db;
  rendezvous(c: Context): Rendezvous;
  /** The browser's address as the platform sees it, if known. */
  clientIp(c: Context): string | undefined;
  /** The page at `path` (a file in public/, as served), or undefined. */
  page(c: Context, path: string): Response | undefined | Promise<Response | undefined>;
  /** Serve every page through the app (self-hosted); Cloudflare serves them before the Worker runs. */
  servesPages?: boolean;
}

/** Hex SHA-256 of the key, grouped: what both the CLI and the page show. */
export async function fingerprint(publicKey: string): Promise<string> {
  const hex = await sha256Hex(publicKey);
  return hex.slice(0, 16).match(/.{4}/g)!.join(' ');
}

function validPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return fromBase64url(value).length === 32;
  } catch {
    return false;
  }
}

function bearer(c: Context): string | undefined {
  const header = c.req.header('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

export function createApp(platform: Platform): Hono {
  const { config } = platform;
  const app = new Hono();

  const headers = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"]
    },
    referrerPolicy: 'no-referrer'
  });
  // Upgrade responses (from a Durable Object on Cloudflare) cannot take headers, and need none.
  app.use((c, next) => (c.req.header('Upgrade')?.toLowerCase() === 'websocket' ? next() : headers(c, next)));
  // Cookie-authenticated changes must come from our own pages.
  app.use('/api/*', csrf({ origin: config.publicUrl.origin }));
  app.use('/auth/*', csrf({ origin: config.publicUrl.origin }));

  authRoutes(app, config, platform.db);

  // What connectors check before anything else; see "Versioning" in docs/PROTOCOL.md.
  app.get('/api/version', (c) => c.json(versionInfo()));
  for (const path of ['/api/device/code', '/api/device/token', '/api/connector', '/api/connector/*', '/connect', '/connect/*']) {
    app.use(path, requireProtocol());
  }

  const requireUser = async (c: Context): Promise<string | undefined> => sessionUser(c, config);

  /** The connector a bearer token belongs to. */
  const connectorFor = async (c: Context) => {
    const token = bearer(c);
    if (!token) return undefined;
    const [row] = await platform
      .db(c)
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.tokenHash, await sha256Hex(token)));
    return row;
  };

  // Account.
  app.get('/api/me', async (c) => {
    const providers = { github: Boolean(config.github), google: Boolean(config.google), passkey: true };
    const userId = await requireUser(c);
    const db = platform.db(c);
    const [user] = userId ? await db.select().from(schema.users).where(eq(schema.users.id, userId)) : [];
    if (!user) return c.json({ user: null, providers });
    const identities = await db
      .select({ provider: schema.identities.provider, createdAt: schema.identities.createdAt })
      .from(schema.identities)
      .where(eq(schema.identities.userId, user.id));
    const passkeys = await db
      .select({ id: schema.passkeys.id, createdAt: schema.passkeys.createdAt })
      .from(schema.passkeys)
      .where(eq(schema.passkeys.userId, user.id));
    return c.json({ user: { id: user.id, displayName: user.displayName, createdAt: user.createdAt }, identities, passkeys, providers });
  });

  /** Everything stored about the account (GDPR access and portability). */
  app.get('/api/me/export', async (c) => {
    const userId = await requireUser(c);
    if (!userId) return c.json({ error: 'Sign in first' }, 401);
    const db = platform.db(c);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const identities = await db.select().from(schema.identities).where(eq(schema.identities.userId, userId));
    const passkeys = await db
      .select({ id: schema.passkeys.id, createdAt: schema.passkeys.createdAt, transports: schema.passkeys.transports })
      .from(schema.passkeys)
      .where(eq(schema.passkeys.userId, userId));
    const connectors = await db
      .select({
        id: schema.connectors.id,
        name: schema.connectors.name,
        region: schema.connectors.region,
        publicKey: schema.connectors.publicKey,
        createdAt: schema.connectors.createdAt,
        lastSeenAt: schema.connectors.lastSeenAt
      })
      .from(schema.connectors)
      .where(eq(schema.connectors.userId, userId));
    c.header('Content-Disposition', 'attachment; filename="codeflower-tunnel-account.json"');
    return c.json({ user, identities, passkeys, connectors });
  });

  /** Deletes the account; its identities, passkeys and connectors go with it. */
  app.delete('/api/me', async (c) => {
    const userId = await requireUser(c);
    if (!userId) return c.json({ error: 'Sign in first' }, 401);
    const db = platform.db(c);
    const owned = await db.select({ id: schema.connectors.id }).from(schema.connectors).where(eq(schema.connectors.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    for (const { id } of owned) await platform.rendezvous(c).disconnect(id);
    signOut(c, config);
    return c.json({ ok: true });
  });

  app.delete('/api/passkeys/:id', async (c) => {
    const userId = await requireUser(c);
    if (!userId) return c.json({ error: 'Sign in first' }, 401);
    await platform
      .db(c)
      .delete(schema.passkeys)
      .where(and(eq(schema.passkeys.id, c.req.param('id')), eq(schema.passkeys.userId, userId)));
    return c.json({ ok: true });
  });

  // Connectors.
  app.get('/api/connectors', async (c) => {
    const userId = await requireUser(c);
    if (!userId) return c.json({ error: 'Sign in first' }, 401);
    const db = platform.db(c);
    const owned = eq(schema.connectors.userId, userId);
    const rendezvous = platform.rendezvous(c);
    // Statuses first: one that finds a connection gone records when it was last seen.
    const ids = await db.select({ id: schema.connectors.id }).from(schema.connectors).where(owned);
    const statuses = new Map(await Promise.all(ids.map(async ({ id }) => [id, await rendezvous.status(id)] as const)));
    const rows = await db.select().from(schema.connectors).where(owned);
    return c.json(
      await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          name: row.name,
          region: row.region,
          fingerprint: await fingerprint(row.publicKey),
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          ...(statuses.get(row.id) ?? { online: false })
        }))
      )
    );
  });

  app.delete('/api/connectors/:id', async (c) => {
    const userId = await requireUser(c);
    if (!userId) return c.json({ error: 'Sign in first' }, 401);
    const id = c.req.param('id');
    const deleted = await platform
      .db(c)
      .delete(schema.connectors)
      .where(and(eq(schema.connectors.id, id), eq(schema.connectors.userId, userId)))
      .returning({ id: schema.connectors.id });
    if (deleted.length === 0) return c.json({ error: 'No such connector' }, 404);
    await platform.rendezvous(c).disconnect(id);
    return c.json({ ok: true });
  });

  // Connector registration: the OAuth device flow (RFC 8628), see docs/PROTOCOL.md.
  app.post('/api/device/code', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; region?: unknown; publicKey?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (body.region !== 'eu' && body.region !== 'any') return c.json({ error: 'region must be "eu" or "any"' }, 400);
    if (!validPublicKey(body.publicKey)) return c.json({ error: 'publicKey must be a base64url X25519 key' }, 400);
    const db = platform.db(c);
    await db.delete(schema.deviceCodes).where(lt(schema.deviceCodes.expiresAt, Date.now()));
    const deviceCode = randomToken();
    const code = userCode();
    await db.insert(schema.deviceCodes).values({
      codeHash: await sha256Hex(deviceCode),
      userCode: code,
      name,
      region: body.region,
      publicKey: body.publicKey,
      status: 'pending',
      expiresAt: Date.now() + DEVICE_CODE_SECONDS * 1000
    });
    return c.json({
      deviceCode,
      userCode: code,
      verificationUrl: new URL(`/device?code=${code}`, config.publicUrl).toString(),
      interval: 3,
      expiresIn: DEVICE_CODE_SECONDS
    });
  });

  const pendingCode = async (c: Context, code: string) => {
    const [row] = await platform
      .db(c)
      .select()
      .from(schema.deviceCodes)
      .where(and(eq(schema.deviceCodes.userCode, code.toUpperCase()), eq(schema.deviceCodes.status, 'pending')));
    return row && row.expiresAt > Date.now() ? row : undefined;
  };

  /** What the approval page shows: the name, region and key fingerprint the CLI also prints. */
  app.get('/api/device/:code', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'Sign in first' }, 401);
    const row = await pendingCode(c, c.req.param('code'));
    if (!row) return c.json({ error: 'This code is unknown or expired' }, 404);
    return c.json({ name: row.name, region: row.region, fingerprint: await fingerprint(row.publicKey) });
  });

  for (const decision of ['approve', 'deny'] as const) {
    app.post(`/api/device/${decision}`, async (c) => {
      const userId = await requireUser(c);
      if (!userId) return c.json({ error: 'Sign in first' }, 401);
      const body = (await c.req.json().catch(() => ({}))) as { userCode?: unknown };
      const row = typeof body.userCode === 'string' ? await pendingCode(c, body.userCode) : undefined;
      if (!row) return c.json({ error: 'This code is unknown or expired' }, 404);
      const db = platform.db(c);
      if (decision === 'approve') {
        const owned = await db.select({ id: schema.connectors.id }).from(schema.connectors).where(eq(schema.connectors.userId, userId));
        if (owned.length >= MAX_CONNECTORS) return c.json({ error: `At most ${MAX_CONNECTORS} connectors per account` }, 409);
      }
      await db
        .update(schema.deviceCodes)
        .set({ status: decision === 'approve' ? 'approved' : 'denied', userId })
        .where(and(eq(schema.deviceCodes.codeHash, row.codeHash), eq(schema.deviceCodes.status, 'pending')));
      return c.json({ ok: true });
    });
  }

  app.post('/api/device/token', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { deviceCode?: unknown };
    if (typeof body.deviceCode !== 'string') return c.json({ error: 'invalid_request' }, 400);
    const db = platform.db(c);
    const codeHash = await sha256Hex(body.deviceCode);
    const [row] = await db.select().from(schema.deviceCodes).where(eq(schema.deviceCodes.codeHash, codeHash));
    if (!row || row.expiresAt <= Date.now()) return c.json({ error: 'expired_token' }, 400);
    if (row.status === 'denied') {
      await db.delete(schema.deviceCodes).where(eq(schema.deviceCodes.codeHash, codeHash));
      return c.json({ error: 'access_denied' }, 400);
    }
    if (row.status === 'pending') return c.json({ error: 'authorization_pending' }, 400);
    // One statement claims the code, so it works once even when polled twice at once.
    const [claimed] = await db
      .delete(schema.deviceCodes)
      .where(and(eq(schema.deviceCodes.codeHash, codeHash), eq(schema.deviceCodes.status, 'approved')))
      .returning();
    if (!claimed?.userId) return c.json({ error: 'expired_token' }, 400);
    const id = connectorId(claimed.region as Region, randomId());
    const token = randomToken();
    await db.insert(schema.connectors).values({
      id,
      userId: claimed.userId,
      name: claimed.name,
      region: claimed.region,
      publicKey: claimed.publicKey,
      tokenHash: await sha256Hex(token),
      createdAt: Date.now()
    });
    return c.json({ connectorId: id, token });
  });

  // A connector managing itself, with its token.
  app.put('/api/connector/key', async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { publicKey?: unknown };
    if (!validPublicKey(body.publicKey)) return c.json({ error: 'publicKey must be a base64url X25519 key' }, 400);
    await platform.db(c).update(schema.connectors).set({ publicKey: body.publicKey }).where(eq(schema.connectors.id, connector.id));
    return c.json({ ok: true, fingerprint: await fingerprint(body.publicKey) });
  });

  app.delete('/api/connector', async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: 'unauthorized' }, 401);
    await platform.db(c).delete(schema.connectors).where(eq(schema.connectors.id, connector.id));
    await platform.rendezvous(c).disconnect(connector.id);
    return c.json({ ok: true });
  });

  // Sockets.
  app.get('/connect', async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: 'unauthorized' }, 401);
    await platform.db(c).update(schema.connectors).set({ lastSeenAt: Date.now() }).where(eq(schema.connectors.id, connector.id));
    return platform.rendezvous(c).accept(c, connector.id, 'control');
  });

  app.get('/connect/streams/:stream', async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: 'unauthorized' }, 401);
    return platform.rendezvous(c).accept(c, connector.id, 'connector', { stream: c.req.param('stream') });
  });

  app.get('/c/:connectorId/stream', async (c) => {
    // WebSockets are not bound by CORS: refuse other sites' pages outright.
    if (c.req.header('Origin') !== config.publicUrl.origin) return c.json({ error: 'wrong origin' }, 403);
    const raw = platform.clientIp(c);
    const ip = raw === undefined ? undefined : normalizeAddress(raw);
    // An unknown address is refused too: the allowlist fails closed.
    if (config.allowedIps.length > 0 && !(ip && inRanges(ip, config.allowedIps))) {
      return c.json({ error: 'address_not_allowed', message: 'This address may not reach connectors' }, 403);
    }
    const userId = await requireUser(c);
    if (!userId) return c.json({ error: 'Sign in first' }, 401);
    const id = c.req.param('connectorId');
    const [owned] = await platform
      .db(c)
      .select({ id: schema.connectors.id })
      .from(schema.connectors)
      .where(and(eq(schema.connectors.id, id), eq(schema.connectors.userId, userId)));
    if (!owned) return c.json({ error: 'No such connector' }, 404);
    return platform.rendezvous(c).accept(c, id, 'browser', { ip });
  });

  // The app's page through the tunnel: the bootstrap installs the service
  // worker that fetches everything under /m/{connector}/ from the connector.
  app.get('/m/*', async (c) => (await platform.page(c, '/m')) ?? c.notFound());
  if (platform.servesPages) app.get('*', async (c) => (await platform.page(c, c.req.path)) ?? c.notFound());

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
