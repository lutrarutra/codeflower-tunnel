// The rendezvous for one connector: its control socket and the streams
// browsers open to it. The hub keeps no state of its own: everything it needs
// is on the sockets (role, stream, when it opened), so a Durable Object can
// hibernate and wake with nothing lost. See docs/PROTOCOL.md.

import { randomId } from './crypto.ts';

export type Role = 'control' | 'browser' | 'connector';

export interface PeerInfo {
  role: Role;
  /** The stream a browser or connector socket belongs to. */
  stream?: string;
  /** A browser's address, passed on to the connector. */
  ip?: string;
  openedAt: number;
  /** Set when the hub closed it: it may linger until its close event. */
  closing?: boolean;
  /** How many sandboxes a control socket's connector reports running. */
  sandboxes?: number;
  /** When a control socket last sent `ping`. */
  pingedAt?: number;
}

export interface Peer {
  readonly info: PeerInfo;
  send(data: string | ArrayBuffer): void;
  close(code: number, reason: string): void;
}

/** Where the platform keeps the sockets: Durable Object tags, or a set. */
export interface Peers {
  add(peer: Peer): void;
  all(): Peer[];
}

export const MAX_FRAME = 256 * 1024;
export const MAX_STREAMS = 64;
export const DIAL_BACK_MS = 15_000;
/** A control socket without a `ping` for this long is gone (connectors ping every 30 s). */
export const STALE_MS = 90_000;

export const CLOSE = {
  replaced: 4000,
  unauthorized: 4401,
  offline: 4404,
  timeout: 4408,
  tooMany: 4429,
  textFrame: 1003,
  tooBig: 1009
} as const;

function live(peers: Peers): Peer[] {
  return peers.all().filter((peer) => !peer.info.closing);
}

function find(peers: Peers, role: Role, stream?: string): Peer | undefined {
  return live(peers).find((peer) => peer.info.role === role && (stream === undefined || peer.info.stream === stream));
}

function partner(peers: Peers, peer: Peer): Peer | undefined {
  if (peer.info.role === 'control') return undefined;
  return find(peers, peer.info.role === 'browser' ? 'connector' : 'browser', peer.info.stream);
}

/** Codes a close frame may carry; 1005 and 1006 are only ever reported. */
function sendable(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006)
    ? code
    : 1000;
}

function safeClose(peer: Peer, code: number, reason: string): void {
  peer.info.closing = true;
  try {
    peer.close(sendable(code), reason);
  } catch {
    // Already closed.
  }
}

/** The connector's control socket arrives: it replaces any older one. */
export function attachControl(peers: Peers, peer: Peer): void {
  for (const old of live(peers)) {
    if (old.info.role === 'control') safeClose(old, CLOSE.replaced, 'Replaced by a newer connection');
  }
  peers.add(peer);
}

/**
 * A browser opens a stream: ask the connector to dial back. Returns false
 * (and closes the browser) when it cannot.
 */
export function openStream(peers: Peers, peer: Peer, makeId: () => string = randomId): boolean {
  const control = find(peers, 'control');
  if (!control) {
    safeClose(peer, CLOSE.offline, 'The connector is offline');
    return false;
  }
  if (live(peers).filter((other) => other.info.role === 'browser').length >= MAX_STREAMS) {
    safeClose(peer, CLOSE.tooMany, 'Too many open streams');
    return false;
  }
  peer.info.stream = makeId();
  peers.add(peer);
  control.send(JSON.stringify({ type: 'open', stream: peer.info.stream, ip: peer.info.ip }));
  return true;
}

/** The connector dials back for a stream: pair it and tell the browser. */
export function attachConnectorStream(peers: Peers, peer: Peer): boolean {
  const browser = find(peers, 'browser', peer.info.stream);
  if (!browser || find(peers, 'connector', peer.info.stream)) {
    safeClose(peer, CLOSE.timeout, 'No browser waits for this stream');
    return false;
  }
  peers.add(peer);
  browser.send(JSON.stringify({ type: 'ready' }));
  return true;
}

function size(data: string | ArrayBuffer | ArrayBufferView): number {
  return typeof data === 'string' ? data.length : data.byteLength;
}

/** The most sandboxes a status may report; more are counted as this many. */
export const MAX_SANDBOXES = 1000;

/** A frame from any socket of this connector. */
export function message(peers: Peers, peer: Peer, data: string | ArrayBuffer): void {
  // `ping` is answered by the platform; the connector's status is the only other frame.
  if (peer.info.role === 'control') return controlMessage(peer, data);
  const other = partner(peers, peer);
  if (typeof data === 'string') return closeStream(peers, peer, CLOSE.textFrame, 'Streams carry binary frames only');
  if (size(data) > MAX_FRAME) return closeStream(peers, peer, CLOSE.tooBig, 'Frame too large');
  // Before `ready` there is no partner; a browser that sends early loses the frame and the stream.
  if (!other) return closeStream(peers, peer, CLOSE.timeout, 'The stream is not open yet');
  other.send(data);
}

function controlMessage(peer: Peer, data: string | ArrayBuffer): void {
  if (typeof data !== 'string' || data.length > 1024) return;
  let status: { type?: unknown; sandboxes?: unknown };
  try {
    status = JSON.parse(data);
  } catch {
    return;
  }
  const count = status?.sandboxes;
  if (status?.type === 'status' && Number.isInteger(count) && (count as number) >= 0) {
    peer.info.sandboxes = Math.min(count as number, MAX_SANDBOXES);
  }
}

function closeStream(peers: Peers, peer: Peer, code: number, reason: string): void {
  const other = partner(peers, peer);
  safeClose(peer, code, reason);
  if (other) safeClose(other, code, reason);
}

/** A socket closed: close the other end of its stream the same way. */
export function closed(peers: Peers, peer: Peer, code: number, reason: string): void {
  const other = partner(peers, peer);
  if (other) safeClose(other, code, reason);
}

/** Closes browsers whose connector did not dial back in time. Returns how many still wait. */
export function sweep(peers: Peers, now: number): number {
  let waiting = 0;
  for (const peer of live(peers)) {
    if (peer.info.role !== 'browser' || partner(peers, peer)) continue;
    if (now - peer.info.openedAt >= DIAL_BACK_MS) safeClose(peer, CLOSE.timeout, 'The connector did not answer');
    else waiting++;
  }
  return waiting;
}

/** The connector was revoked: close everything. */
export function disconnectAll(peers: Peers, reason: string): void {
  for (const peer of live(peers)) safeClose(peer, CLOSE.unauthorized, reason);
}

/** When the connector was last heard from on this control socket. */
export function seenAt(info: PeerInfo): number {
  return Math.max(info.openedAt, info.pingedAt ?? 0);
}

/**
 * Closes a control socket that stopped pinging: a computer that slept or lost
 * its network sends no close. Returns when it was last seen, if it closed one.
 */
export function expire(peers: Peers, now: number): number | undefined {
  const control = find(peers, 'control');
  if (!control || now - seenAt(control.info) < STALE_MS) return undefined;
  safeClose(control, CLOSE.timeout, 'No ping from the connector');
  return seenAt(control.info);
}

/**
 * When a closed control socket's connector was last seen: now, unless the hub
 * closed it (replaced or stale), when it was its last ping.
 */
export function closedAt(info: PeerInfo, now: number): number {
  return info.closing ? seenAt(info) : now;
}

export interface Status {
  online: boolean;
  /** Left out while offline, and for connectors that do not report it. */
  sandboxes?: number;
}

export function status(peers: Peers): Status {
  const control = find(peers, 'control');
  return control ? { online: true, sandboxes: control.info.sandboxes } : { online: false };
}
