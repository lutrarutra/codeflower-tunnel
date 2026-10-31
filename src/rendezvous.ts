import type { Context } from 'hono';
import type { Role } from './hub.ts';

/**
 * Where a connector's sockets meet: a Durable Object per connector on
 * Cloudflare, a map in the one process when self-hosted. The app has already
 * authenticated the socket when it calls `accept`.
 */
export interface Rendezvous {
  /** Answers the WebSocket upgrade in `c` as one of the connector's sockets. */
  accept(c: Context, connectorId: string, role: Role, details?: SocketDetails): Response | Promise<Response>;
  online(connectorId: string): Promise<boolean>;
  /** Closes all of the connector's sockets (it was revoked). */
  disconnect(connectorId: string): Promise<void>;
}

export interface SocketDetails {
  /** The stream a connector socket dials back for. */
  stream?: string;
  /** A browser's address. */
  ip?: string;
}

export type Region = 'eu' | 'any';

/** The region is part of the ID, so routing needs no lookup. */
export function connectorId(region: Region, random: string): string {
  return region === 'eu' ? `eu_${random}` : random;
}

export function regionOf(connectorId: string): Region {
  return connectorId.startsWith('eu_') ? 'eu' : 'any';
}
