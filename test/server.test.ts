// The self-hosted server end to end: a connector registers through the device
// flow, a browser opens a stream, frames pass both ways, revoking cuts it.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import { sign } from '../src/crypto.ts';
import { schema, type Db } from '../src/db/index.ts';
import { createServerApp, openDatabase } from '../src/node.ts';
import { MIN_PROTOCOL, PROTOCOL, PROTOCOL_HEADER } from '../src/version.ts';

const SECRET = 'test-secret-test-secret-test-secret';
let base: string;
let db: Db;
let stop: () => void;

/** A server on a free port, sharing `db`; the public URL must match the port, so one is reserved first. */
async function start(env: Record<string, string> = {}) {
  const probe = serve({ fetch: () => new Response(), port: 0, hostname: '127.0.0.1' });
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const { server, injectWebSocket, rendezvous } = createServerApp({ PUBLIC_URL: url, COOKIE_SECRET: SECRET, ...env }, db);
  const listening = serve({ fetch: server.fetch, port, hostname: '127.0.0.1' });
  injectWebSocket(listening);
  await once(listening, 'listening');
  return {
    url,
    stop: () => {
      rendezvous.close();
      listening.close();
    }
  };
}

before(async () => {
  db = openDatabase(':memory:');
  const started = await start();
  base = started.url;
  stop = started.stop;
});

after(() => stop());

async function userWithSession(id: string): Promise<string> {
  await db.insert(schema.users).values({ id, displayName: id, createdAt: Date.now() });
  const value = await sign(SECRET, { u: id, e: Math.floor(Date.now() / 1000) + 3600 });
  return `cft_session=${value}`;
}

// Response bodies the tests inspect freely.
const json = (response: Response): Promise<any> => response.json();

function post(path: string, body: unknown, cookie?: string) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      [PROTOCOL_HEADER]: String(PROTOCOL),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64url');

/** Runs the device flow for `cookie`'s user; returns the connector's ID and token. */
async function register(cookie: string, region: 'eu' | 'any' = 'any') {
  const code = await json(await post('/api/device/code', { name: 'laptop', region, publicKey: PUBLIC_KEY }));
  const pending = await json(await post('/api/device/token', { deviceCode: code.deviceCode }));
  assert.equal(pending.error, 'authorization_pending');

  const info = await fetch(`${base}/api/device/${code.userCode}`, { headers: { Cookie: cookie } });
  assert.equal((await json(info)).region, region);
  assert.equal((await post('/api/device/approve', { userCode: code.userCode }, cookie)).status, 200);

  const granted = await post('/api/device/token', { deviceCode: code.deviceCode });
  assert.equal(granted.status, 200);
  const result = (await json(granted)) as { connectorId: string; token: string };
  // The code works once.
  assert.equal((await json(await post('/api/device/token', { deviceCode: code.deviceCode }))).error, 'expired_token');
  return result;
}

function socket(path: string, headers: Record<string, string>, on = base): WebSocket {
  return new WebSocket(on.replace('http', 'ws') + path, { headers: { [PROTOCOL_HEADER]: String(PROTOCOL), ...headers } });
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer | string; binary: boolean }> {
  return new Promise((resolve) =>
    ws.once('message', (data, binary) => resolve({ data: binary ? (data as Buffer) : data.toString(), binary }))
  );
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

test('a registered connector and its owner exchange binary frames through a stream', async () => {
  const cookie = await userWithSession('alice');
  const { connectorId, token } = await register(cookie, 'eu');
  assert.match(connectorId, /^eu_[a-z2-7]{26}$/);

  const control = socket('/connect', { Authorization: `Bearer ${token}` });
  await once(control, 'open');
  const listed = await json(await fetch(`${base}/api/connectors`, { headers: { Cookie: cookie } }));
  assert.equal(listed[0].online, true);
  assert.equal(listed[0].sandboxes, undefined);
  assert.match(listed[0].fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  control.send('{"type":"status","sandboxes":3}');
  await assert.doesNotReject(async () => {
    for (let tries = 0; tries < 50; tries++) {
      const [connector] = await json(await fetch(`${base}/api/connectors`, { headers: { Cookie: cookie } }));
      if (connector.sandboxes === 3) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the status did not arrive');
  });

  const opened = nextMessage(control);
  const browser = socket(`/c/${connectorId}/stream`, { Cookie: cookie, Origin: base });
  const ready = nextMessage(browser);
  const request = JSON.parse((await opened).data as string);
  assert.equal(request.type, 'open');
  // The connector learns where the browser connects from.
  assert.equal(request.ip, '127.0.0.1');

  const connector = socket(`/connect/streams/${request.stream}`, { Authorization: `Bearer ${token}` });
  await once(connector, 'open');
  assert.deepEqual(JSON.parse((await ready).data as string), { type: 'ready' });

  const toConnector = nextMessage(connector);
  browser.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(await toConnector, { data: Buffer.from([1, 2, 3]), binary: true });
  const toBrowser = nextMessage(browser);
  connector.send(Buffer.from([9]));
  assert.deepEqual(await toBrowser, { data: Buffer.from([9]), binary: true });

  // Revoking closes everything and the token stops working.
  const closed = Promise.all([closeCode(control), closeCode(browser), closeCode(connector)]);
  const revoked = await fetch(`${base}/api/connectors/${connectorId}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await closed, [4401, 4401, 4401]);
  const again = socket('/connect', { Authorization: `Bearer ${token}` });
  const refused = await new Promise<number>((resolve) => again.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
  assert.equal(refused, 401);
});

test('a connector is last seen when its control socket closes', async () => {
  const cookie = await userWithSession('heidi');
  const { token } = await register(cookie);
  const control = socket('/connect', { Authorization: `Bearer ${token}` });
  await once(control, 'open');
  const [connected] = await json(await fetch(`${base}/api/connectors`, { headers: { Cookie: cookie } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Not a clean close: as when the computer's process is killed.
  control.terminate();
  let listed: any;
  for (let tries = 0; tries < 50; tries++) {
    [listed] = await json(await fetch(`${base}/api/connectors`, { headers: { Cookie: cookie } }));
    if (!listed.online && listed.lastSeenAt > connected.lastSeenAt) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(listed.online, false);
  assert.ok(listed.lastSeenAt > connected.lastSeenAt, 'last seen is when it closed, not when it connected');
});

test('browsers reach only their own connectors, from the tunnel\'s own pages', async () => {
  const owner = await userWithSession('bob');
  const stranger = await userWithSession('carol');
  const { connectorId } = await register(owner);

  const status = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const ws = socket(`/c/${connectorId}/stream`, headers);
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => resolve(101));
    });
  assert.equal(await status({ Cookie: stranger, Origin: base }), 404);
  assert.equal(await status({ Cookie: owner, Origin: 'https://evil.example' }), 403);
  assert.equal(await status({ Origin: base }), 401);
});

test('with ALLOWED_IPS, only browsers at those addresses open streams; the proxy names the address', async () => {
  const cookie = await userWithSession('grace');
  const { connectorId, token } = await register(cookie);
  const guarded = await start({ ALLOWED_IPS: '10.0.0.0/8, 2001:db8::1', CLIENT_IP_HEADER: 'X-Forwarded-For' });
  try {
    const control = socket('/connect', { Authorization: `Bearer ${token}` }, guarded.url);
    await once(control, 'open');
    const status = (forwardedFor?: string) =>
      new Promise<number>((resolve) => {
        const headers: Record<string, string> = { Cookie: cookie, Origin: guarded.url };
        if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;
        const ws = socket(`/c/${connectorId}/stream`, headers, guarded.url);
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('open', () => {
          ws.close();
          resolve(101);
        });
      });
    const opened = nextMessage(control);
    // The last address is the one the proxy saw; earlier ones are the client's to forge.
    assert.equal(await status('10.9.9.9, 10.1.2.3'), 101);
    assert.equal(JSON.parse((await opened).data as string).ip, '10.1.2.3');
    assert.equal(await status('2001:db8:0::1'), 101);
    assert.equal(await status('10.1.2.3, 203.0.113.4'), 403);
    assert.equal(await status(), 403);
    control.close();
  } finally {
    guarded.stop();
  }
});

test('ALLOWED_IPS refuses entries that are not addresses or ranges', () => {
  assert.throws(() => createServerApp({ PUBLIC_URL: base, COOKIE_SECRET: SECRET, ALLOWED_IPS: '10.0.0.0/33' }, db), /ALLOWED_IPS/);
});

test('a stream to an offline connector closes with 4404', async () => {
  const cookie = await userWithSession('dave');
  const { connectorId } = await register(cookie);
  const browser = socket(`/c/${connectorId}/stream`, { Cookie: cookie, Origin: base });
  assert.equal(await closeCode(browser), 4404);
});

test('deleting the account deletes its connectors and exports what is stored first', async () => {
  const cookie = await userWithSession('erin');
  const { connectorId } = await register(cookie);
  const exported = await json(await fetch(`${base}/api/me/export`, { headers: { Cookie: cookie } }));
  assert.equal(exported.user.id, 'erin');
  assert.equal(exported.connectors[0].id, connectorId);
  assert.equal(JSON.stringify(exported).includes('token'), false);

  const deleted = await fetch(`${base}/api/me`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
  assert.equal(deleted.status, 200);
  const rows = await db.select().from(schema.connectors);
  assert.equal(rows.some((row) => row.id === connectorId), false);
});

test('device codes need a name, a region and a 32-byte key', async () => {
  assert.equal((await post('/api/device/code', { name: 'x', region: 'mars', publicKey: PUBLIC_KEY })).status, 400);
  assert.equal((await post('/api/device/code', { name: 'x', region: 'eu', publicKey: 'short' })).status, 400);
  assert.equal((await post('/api/device/code', { region: 'eu', publicKey: PUBLIC_KEY })).status, 400);
});

test('connectors too old for the tunnel are told to update, and too new ones that the tunnel is old', async () => {
  const version = await json(await fetch(`${base}/api/version`));
  assert.deepEqual(version, { protocol: PROTOCOL, minProtocol: MIN_PROTOCOL, deprecated: null });

  const request = (protocol?: number) =>
    fetch(`${base}/api/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(protocol === undefined ? {} : { [PROTOCOL_HEADER]: String(protocol) }) },
      body: JSON.stringify({ name: 'x', region: 'eu', publicKey: PUBLIC_KEY })
    });
  for (const old of [undefined, MIN_PROTOCOL - 1]) {
    const response = await request(old);
    assert.equal(response.status, 426);
    const body = await json(response);
    assert.equal(body.error, 'upgrade_required');
    assert.equal(body.minProtocol, MIN_PROTOCOL);
  }
  const newer = await request(PROTOCOL + 1);
  assert.equal(newer.status, 400);
  assert.equal((await json(newer)).error, 'tunnel_too_old');

  const control = new WebSocket(base.replace('http', 'ws') + '/connect', { headers: { [PROTOCOL_HEADER]: '0', Authorization: 'Bearer x' } });
  const status = await new Promise<number>((resolve) => control.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
  assert.equal(status, 426);
});

test('pages are served with a strict content security policy, and nothing outside public/', async () => {
  for (const path of ['/', '/device', '/account.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /script-src 'self'/);
  }
  for (const path of ['/package.json', '/src/app.ts', '/device.html/x']) assert.equal((await fetch(base + path)).status, 404, path);
});

test('the bootstrap answers every path under /m/, and the pairing page /p', async () => {
  for (const path of ['/m/eu_abc/', '/m/eu_abc/api/workers', '/p']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /script-src 'self'/);
  }
  assert.match(await (await fetch(`${base}/m/x/`)).text(), /tunnel\/m\.js/);
  for (const script of ['/tunnel/m.js', '/tunnel/p.js', '/sw.js']) assert.equal((await fetch(base + script)).status, 200, script);
});

test('a connector can replace its key and remove itself, with its token only', async () => {
  const cookie = await userWithSession('frank');
  const { connectorId, token } = await register(cookie);
  const call = (method: string, path: string, bearer: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  const newKey = Buffer.alloc(32, 9).toString('base64url');
  assert.equal((await call('PUT', '/api/connector/key', 'wrong', { publicKey: newKey })).status, 401);
  assert.equal((await call('PUT', '/api/connector/key', token, { publicKey: 'short' })).status, 400);
  assert.equal((await call('PUT', '/api/connector/key', token, { publicKey: newKey })).status, 200);
  const [row] = (await db.select().from(schema.connectors)).filter((connector) => connector.id === connectorId);
  assert.equal(row.publicKey, newKey);

  assert.equal((await call('DELETE', '/api/connector', token)).status, 200);
  assert.equal((await db.select().from(schema.connectors)).some((connector) => connector.id === connectorId), false);
  assert.equal((await call('DELETE', '/api/connector', token)).status, 401);
});
