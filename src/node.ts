// Self-hosted entry: one Node process, accounts in the SQLite file named by
// TUNNEL_DB (created and migrated at startup), sockets paired in memory.

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { createApp } from './app.ts';
import { readConfig, type Env } from './config.ts';
import { schema, type Db } from './db/index.ts';
import { MemoryRendezvous } from './memory.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Opens (creating it if needed) and migrates the database file. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  // D1 always enforces foreign keys; SQLite only when asked. Deleting an account cascades.
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(root, 'migrations') });
  return db;
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

/**
 * The pages, read once: only these exact paths are served, so no request
 * path ever reaches the file system. `/device` serves device.html, as
 * Workers static assets do.
 */
function pages(): Map<string, { body: Uint8Array<ArrayBuffer>; type: string }> {
  const folder = join(root, 'public');
  const served = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
  for (const name of readdirSync(folder, { recursive: true }) as string[]) {
    const extension = name.slice(name.lastIndexOf('.'));
    const type = types[extension];
    if (!type) continue;
    const path = name.split(sep).join('/');
    const page = { body: new Uint8Array(readFileSync(join(folder, name))), type };
    served.set(`/${path}`, page);
    if (extension === '.html') served.set(path === 'index.html' ? '/' : `/${path.slice(0, -5)}`, page);
  }
  return served;
}

export function createServerApp(env: Env, db: Db) {
  const config = readConfig(env);
  const server = new Hono();
  const ws = createNodeWebSocket({ app: server });
  const rendezvous = new MemoryRendezvous(ws.upgradeWebSocket);
  const served = pages();
  const app = createApp({
    config,
    db: () => db,
    rendezvous: () => rendezvous,
    servesPages: true,
    page: (_c, path) => {
      const page = served.get(path);
      return page && new Response(page.body, { headers: { 'Content-Type': page.type } });
    }
  });
  server.route('/', app);
  return { server, injectWebSocket: ws.injectWebSocket, rendezvous, config };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.env.TUNNEL_DB;
  if (!path) throw new Error('Set TUNNEL_DB to the SQLite file, e.g. /var/lib/codeflower-tunnel/tunnel.sqlite');
  const { server, injectWebSocket, config } = createServerApp(process.env, openDatabase(path));
  const port = Number(process.env.PORT ?? 8787);
  const http = serve({ fetch: server.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, () => {
    console.log(`code flower tunnel on port ${port}, public at ${config.publicUrl.origin}, database ${path}`);
  });
  injectWebSocket(http);
  const stop = () => http.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
