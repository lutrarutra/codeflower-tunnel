// The account database: the only state the tunnel keeps. No session content,
// prompts or file names ever reach it. `npm run db:generate` writes a
// migration after a change here.

import { sqliteTable, text, integer, blob, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at').notNull(),
  /** Session cookies name it: raising it signs every browser out. */
  sessionVersion: integer('session_version').notNull().default(0)
});

/** A GitHub or Google account that signs in as a user. */
export const identities = sqliteTable(
  'identities',
  {
    provider: text('provider', { enum: ['github', 'google'] }).notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.provider, table.subject] }), index('identities_user').on(table.userId)]
);

export const passkeys = sqliteTable(
  'passkeys',
  {
    /** The credential ID, base64url. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    counter: integer('counter').notNull(),
    transports: text('transports'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('passkeys_user').on(table.userId)]
);

export const connectors = sqliteTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    region: text('region', { enum: ['eu', 'any'] }).notNull(),
    /** The connector's X25519 key, base64url, shown to users as a fingerprint. */
    publicKey: text('public_key').notNull(),
    /** SHA-256 of the bearer token, hex. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at')
  },
  (table) => [index('connectors_user').on(table.userId)]
);

/** Pending connector registrations, deleted when exchanged. */
export const deviceCodes = sqliteTable('device_codes', {
  /** SHA-256 of the device code, hex. */
  codeHash: text('code_hash').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  name: text('name').notNull(),
  region: text('region', { enum: ['eu', 'any'] }).notNull(),
  publicKey: text('public_key').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull(),
  /** When and from which address the connector asked: the approval page shows them. */
  requestedAt: integer('requested_at'),
  requestedFrom: text('requested_from')
});
