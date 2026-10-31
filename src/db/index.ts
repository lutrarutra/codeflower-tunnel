import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.ts';

/**
 * Either D1 (async) or better-sqlite3 (sync). Code awaits every query, which
 * works for both, and uses no transactions: D1 has none, so each change that
 * must be atomic is one statement.
 */
export type Db = BaseSQLiteDatabase<'sync' | 'async', any, typeof schema>;

export { schema };
