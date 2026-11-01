import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.ts';

/**
 * Either D1 (async) or better-sqlite3 (sync). Code awaits every query, which
 * works for both, and uses no transactions: D1 has none, so each change that
 * must be atomic is one statement.
 */
export type Db = BaseSQLiteDatabase<'sync' | 'async', any, typeof schema>;

/** Records that the connector was last seen at `at`, unless it was seen later. */
export async function recordSeen(db: Db, connectorId: string, at: number): Promise<void> {
  const { connectors } = schema;
  await db
    .update(connectors)
    .set({ lastSeenAt: at })
    .where(and(eq(connectors.id, connectorId), or(isNull(connectors.lastSeenAt), lt(connectors.lastSeenAt, at))));
}

export { schema };
