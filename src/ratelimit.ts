// How often one address may call the tunnel's routes that anyone can call
// and that write or verify something: new device codes (each a database row),
// passkey and confirmation ceremonies. On Cloudflare a Workers rate-limit
// binding counts them (wrangler.toml); self-hosted, this window in memory.

/** Calls per address and route group in each window. */
export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 60_000;

/** Counts calls per key in fixed windows; `allow` says whether one more fits. */
export class MemoryRateLimit {
  private readonly counts = new Map<string, { window: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  allow(key: string): boolean {
    const window = Math.floor(this.now() / this.windowMs);
    // Keys of past windows go, so the map stays as small as the traffic.
    if (this.counts.size > 10_000) {
      for (const [other, entry] of this.counts) if (entry.window !== window) this.counts.delete(other);
    }
    const entry = this.counts.get(key);
    if (!entry || entry.window !== window) {
      this.counts.set(key, { window, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }
}
