// Which connectors this tunnel accepts. Connectors (codeflower-app) send their
// protocol version with every request; see "Versioning" in docs/PROTOCOL.md.
//
// A breaking change raises PROTOCOL and, once old connectors must stop,
// MIN_PROTOCOL. Before raising MIN_PROTOCOL, set DEPRECATED: connectors read
// it from GET /api/version when they start and reconnect, and warn their users.

import type { Context, MiddlewareHandler } from 'hono';

export const PROTOCOL = 1;
export const MIN_PROTOCOL = 1;

/** Versions still accepted but to be refused from `after` on (an ISO date). */
export const DEPRECATED: { below: number; after: string } | undefined = undefined;

export const PROTOCOL_HEADER = 'Codeflower-Tunnel-Protocol';

export function versionInfo() {
  return { protocol: PROTOCOL, minProtocol: MIN_PROTOCOL, deprecated: DEPRECATED ?? null };
}

function refuse(c: Context, status: 400 | 426, error: string, message: string) {
  return c.json({ error, message, ...versionInfo() }, status);
}

/** Refuses connectors this tunnel cannot talk to. */
export function requireProtocol(): MiddlewareHandler {
  return async (c, next) => {
    const sent = Number(c.req.header(PROTOCOL_HEADER));
    if (!Number.isInteger(sent) || sent < MIN_PROTOCOL) {
      return refuse(c, 426, 'upgrade_required', 'The tunnel was updated. Update code flower to keep using it.');
    }
    if (sent > PROTOCOL) {
      return refuse(c, 400, 'tunnel_too_old', 'This tunnel is older than your code flower. Ask its operator to update it.');
    }
    await next();
  };
}
