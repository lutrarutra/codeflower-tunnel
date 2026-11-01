// Cloudflare entry: the Worker answers HTTP, D1 holds accounts, and one
// Durable Object per connector pairs its sockets. EU connectors' objects live
// in the EU jurisdiction, so their streams pass only through EU datacenters.

import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, Hono } from 'hono';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { recordSeen, schema } from './db/index.ts';
import * as hub from './hub.ts';
import { regionOf, type Rendezvous } from './rendezvous.ts';

interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  CONNECTOR_HUB: DurableObjectNamespace<ConnectorHub>;
  [name: string]: unknown;
}

/** Each socket's hub state rides on it as its attachment, so it survives hibernation. */
interface Attachment extends hub.PeerInfo {
  added: boolean;
  connectorId: string;
}

export class ConnectorHub extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    // Answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private peer(ws: WebSocket): hub.Peer {
    const info = ws.deserializeAttachment() as Attachment;
    // The platform answers `ping` (even while hibernating) and keeps when it last did.
    info.pingedAt = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
    return {
      info,
      send: (data) => ws.send(data),
      close: (code, reason) => {
        ws.serializeAttachment(info);
        ws.close(code, reason);
      }
    };
  }

  private peers(): hub.Peers {
    return {
      // Only the socket `fetch` is accepting is ever added.
      add: (peer) => {
        (peer.info as Attachment).added = true;
        this.pending?.serializeAttachment(peer.info);
      },
      all: () =>
        this.ctx
          .getWebSockets()
          .map((ws) => this.peer(ws))
          .filter((peer) => (peer.info as Attachment).added)
    };
  }

  /** The socket `fetch` is accepting. */
  private pending: WebSocket | undefined;

  private async seen(connectorId: string, at: number): Promise<void> {
    await recordSeen(drizzle(this.env.DB, { schema }), connectorId, at);
  }

  /** Closes a control socket that stopped pinging, recording when it was last seen. */
  private async expire(connectorId: string): Promise<void> {
    const lost = hub.expire(this.peers(), Date.now());
    if (lost !== undefined) await this.seen(connectorId, lost);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as hub.Role;
    const stream = url.searchParams.get('stream') ?? undefined;
    const ip = url.searchParams.get('ip') ?? undefined;
    const connectorId = url.searchParams.get('connector') ?? '';
    if (role === 'browser') await this.expire(connectorId);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Accepted first: a socket must be accepted before it can be closed.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, stream, ip, openedAt: Date.now(), added: false, connectorId } satisfies Attachment);
    const peer = this.peer(server);
    this.pending = server;
    try {
      if (role === 'control') hub.attachControl(this.peers(), peer);
      else if (role === 'browser' && hub.openStream(this.peers(), peer)) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      } else if (role === 'connector') hub.attachConnectorStream(this.peers(), peer);
    } finally {
      this.pending = undefined;
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peer = this.peer(ws);
    if (!(peer.info as Attachment).added || peer.info.closing) return;
    hub.message(this.peers(), peer, message);
    // The connector's status, kept on its socket for after hibernation.
    if (peer.info.role === 'control') ws.serializeAttachment(peer.info);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const peer = this.peer(ws);
    if ((peer.info as Attachment).added) {
      (peer.info as Attachment).added = false;
      ws.serializeAttachment(peer.info);
      hub.closed(this.peers(), peer, code, reason);
      if (peer.info.role === 'control') await this.seen((peer.info as Attachment).connectorId, hub.closedAt(peer.info, Date.now()));
    }
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'Socket error');
  }

  async alarm(): Promise<void> {
    if (hub.sweep(this.peers(), Date.now()) > 0) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async status(connectorId: string): Promise<hub.Status> {
    await this.expire(connectorId);
    return hub.status(this.peers());
  }

  async disconnect(): Promise<void> {
    hub.disconnectAll(this.peers(), 'The connector was revoked');
  }
}

function stub(env: Bindings, connectorId: string) {
  // `wrangler dev` cannot place objects in a jurisdiction; only .dev.vars sets this.
  const eu = regionOf(connectorId) === 'eu' && env.LOCAL_DEV_WITHOUT_JURISDICTIONS !== 'true';
  const namespace = eu ? env.CONNECTOR_HUB.jurisdiction('eu') : env.CONNECTOR_HUB;
  return namespace.get(namespace.idFromName(connectorId));
}

const rendezvous = (env: Bindings): Rendezvous => ({
  accept(c: Context, connectorId, role, { stream, ip } = {}) {
    const url = new URL('https://hub/');
    url.searchParams.set('role', role);
    url.searchParams.set('connector', connectorId);
    if (stream) url.searchParams.set('stream', stream);
    if (ip) url.searchParams.set('ip', ip);
    return stub(env, connectorId).fetch(new Request(url, c.req.raw));
  },
  status: (connectorId) => stub(env, connectorId).status(connectorId),
  disconnect: (connectorId) => stub(env, connectorId).disconnect()
});

let app: Hono | undefined;

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
    app ??= createApp({
      config: readConfig(env),
      db: (c) => drizzle((c.env as Bindings).DB, { schema }),
      rendezvous: (c) => rendezvous(c.env as Bindings),
      clientIp: (c) => c.req.header('CF-Connecting-IP'),
      page: async (c, path) => {
        const response = await (c.env as Bindings).ASSETS.fetch(new URL(path, c.req.url));
        // A copy: responses from fetch() have immutable headers, and the app adds its own.
        return response.ok ? new Response(response.body, response) : undefined;
      }
    });
    return app.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Bindings>;
