// The self-hosted rendezvous: one process holds every connector's sockets, so
// a map is the "one place per connector" a Durable Object gives on Cloudflare.

import type { Context } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import * as hub from './hub.ts';
import type { Rendezvous, SocketDetails } from './rendezvous.ts';

class PeerSet implements hub.Peers {
  readonly peers = new Set<hub.Peer>();
  add(peer: hub.Peer): void {
    this.peers.add(peer);
  }
  all(): hub.Peer[] {
    return [...this.peers];
  }
}

export class MemoryRendezvous implements Rendezvous {
  private readonly connectors = new Map<string, PeerSet>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly upgradeWebSocket: UpgradeWebSocket;
  private readonly now: () => number;

  /** Records when a connector was last seen, once its control socket is gone. */
  private readonly seen: (connectorId: string, at: number) => void;

  constructor(
    upgradeWebSocket: UpgradeWebSocket,
    seen: (connectorId: string, at: number) => void = () => {},
    now: () => number = Date.now
  ) {
    this.upgradeWebSocket = upgradeWebSocket;
    this.seen = seen;
    this.now = now;
    this.timer = setInterval(() => {
      for (const [connectorId, peers] of this.connectors) {
        hub.sweep(peers, this.now());
        this.expire(connectorId, peers);
      }
    }, 1000);
    this.timer.unref?.();
  }

  private expire(connectorId: string, peers: PeerSet): void {
    const lost = hub.expire(peers, this.now());
    if (lost !== undefined) this.seen(connectorId, lost);
  }

  private peersOf(connectorId: string): PeerSet {
    let peers = this.connectors.get(connectorId);
    if (!peers) this.connectors.set(connectorId, (peers = new PeerSet()));
    return peers;
  }

  accept(c: Context, connectorId: string, role: hub.Role, { stream, ip }: SocketDetails = {}): Response | Promise<Response> {
    const peers = this.peersOf(connectorId);
    let peer: hub.Peer | undefined;
    const handler = this.upgradeWebSocket(() => ({
      onOpen: (_event, ws: WSContext) => {
        const opened: hub.Peer = {
          info: { role, stream, ip, openedAt: this.now() },
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason)
        };
        peer = opened;
        if (role === 'control') hub.attachControl(peers, opened);
        else if (role === 'browser') {
          this.expire(connectorId, peers);
          hub.openStream(peers, opened);
        }
        else hub.attachConnectorStream(peers, opened);
      },
      onMessage: (event, ws) => {
        if (!peer || peer.info.closing || !peers.peers.has(peer)) return;
        if (role === 'control' && event.data === 'ping') {
          peer.info.pingedAt = this.now();
          return ws.send('pong');
        }
        const data = event.data;
        hub.message(peers, peer, typeof data === 'string' ? data : (data as ArrayBuffer));
      },
      onClose: (event) => {
        if (!peer) return;
        if (peers.peers.has(peer)) hub.closed(peers, peer, event.code, event.reason);
        if (role === 'control') this.seen(connectorId, hub.closedAt(peer.info, this.now()));
        peers.peers.delete(peer);
        if (peers.peers.size === 0) this.connectors.delete(connectorId);
      }
    }));
    return handler(c, async () => {}) as Promise<Response>;
  }

  async status(connectorId: string): Promise<hub.Status> {
    const peers = this.connectors.get(connectorId);
    if (!peers) return { online: false };
    this.expire(connectorId, peers);
    return hub.status(peers);
  }

  async disconnect(connectorId: string): Promise<void> {
    const peers = this.connectors.get(connectorId);
    if (peers) hub.disconnectAll(peers, 'The connector was revoked');
  }

  close(): void {
    clearInterval(this.timer);
  }
}
