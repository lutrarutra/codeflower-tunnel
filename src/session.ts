// Signed cookies instead of a session table: the session cookie names the
// user and the user's session version, and short-lived flow cookies carry
// OAuth state and passkey challenges. Raising a user's version (signing out
// everywhere, removing a passkey) signs that user's browsers out; rotating
// COOKIE_SECRET signs everyone out.

import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { securePrefix, type Config } from './config.ts';
import { sign, verify } from './crypto.ts';
import { schema, type Db } from './db/index.ts';

export const SESSION_DAYS = 14;

interface Signed {
  /** Expiry, Unix seconds. */
  e: number;
}

function cookieName(config: Config, name: string): string {
  // __Host- cookies must be Secure, which needs https.
  return securePrefix(config) ? `__Host-${name}` : name;
}

async function write(c: Context, config: Config, name: string, payload: object, seconds: number): Promise<void> {
  const value = await sign(config.cookieSecret, { ...payload, e: Math.floor(Date.now() / 1000) + seconds });
  setCookie(c, cookieName(config, name), value, {
    path: '/',
    httpOnly: true,
    secure: securePrefix(config),
    sameSite: 'Lax',
    maxAge: seconds
  });
}

async function read<T extends Signed>(c: Context, config: Config, name: string): Promise<T | undefined> {
  const payload = await verify<T>(config.cookieSecret, getCookie(c, cookieName(config, name)));
  return payload && payload.e > Date.now() / 1000 ? payload : undefined;
}

function remove(c: Context, config: Config, name: string): void {
  deleteCookie(c, cookieName(config, name), { path: '/', secure: securePrefix(config) });
}

export async function signIn(c: Context, config: Config, db: Db, userId: string): Promise<void> {
  const [user] = await db.select({ version: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, userId));
  await write(c, config, 'cft_session', { u: userId, v: user?.version ?? 0 }, SESSION_DAYS * 24 * 3600);
}

/** Signs the user's browsers out, all but this one, which signs in again. */
export async function signOutEverywhere(c: Context, config: Config, db: Db, userId: string): Promise<void> {
  const [user] = await db.select({ version: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, userId));
  await db.update(schema.users).set({ sessionVersion: (user?.version ?? 0) + 1 }).where(eq(schema.users.id, userId));
  await signIn(c, config, db, userId);
}

export function signOut(c: Context, config: Config): void {
  remove(c, config, 'cft_session');
}

/** The signed-in user: the cookie's, if the user still exists and the cookie's version is the user's. */
export async function sessionUser(c: Context, config: Config, db: Db): Promise<string | undefined> {
  const session = await read<Signed & { u: string; v?: number }>(c, config, 'cft_session');
  if (!session) return undefined;
  const [user] = await db.select({ version: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, session.u));
  // Cookies from before versions count as version 0.
  return user && user.version === (session.v ?? 0) ? session.u : undefined;
}

/** State of a sign-in in progress (OAuth redirect, passkey ceremony), valid 10 minutes. */
export async function writeFlow(c: Context, config: Config, flow: object): Promise<void> {
  await write(c, config, 'cft_flow', flow, 600);
}

/**
 * Actions that need the user to confirm them just now (a passkey, or the
 * provider's sign-in again), not only a session: code running on the
 * tunnel's origin (the pages paired computers serve under /m/) has the
 * session too.
 */
export type ConfirmedAction = 'delete-account' | 'delete-connector' | 'approve-device' | 'delete-passkey' | 'add-passkey' | 'sign-out-everywhere';

export const CONFIRMED_ACTIONS: readonly ConfirmedAction[] = [
  'delete-account',
  'delete-connector',
  'approve-device',
  'delete-passkey',
  'add-passkey',
  'sign-out-everywhere'
];

/** How long a confirmation is good for: one action, right after. */
export const CONFIRM_SECONDS = 120;

interface Confirmation extends Signed {
  u: string;
  a: ConfirmedAction;
  t: string;
}

/** Records that the user confirmed `action` on `target` just now. */
export async function writeConfirmation(c: Context, config: Config, userId: string, action: ConfirmedAction, target: string): Promise<void> {
  await write(c, config, 'cft_confirm', { u: userId, a: action, t: target }, CONFIRM_SECONDS);
}

/** Uses up a confirmation of exactly this action on this target by this user, if there is one. */
export async function takeConfirmation(c: Context, config: Config, userId: string, action: ConfirmedAction, target: string): Promise<boolean> {
  const confirmation = await read<Confirmation>(c, config, 'cft_confirm');
  if (!confirmation || confirmation.u !== userId || confirmation.a !== action || confirmation.t !== target) return false;
  remove(c, config, 'cft_confirm');
  return true;
}

/** Reads and removes the flow state: each one is used once. */
export async function takeFlow<T extends object>(c: Context, config: Config): Promise<T | undefined> {
  const flow = await read<Signed & T>(c, config, 'cft_flow');
  remove(c, config, 'cft_flow');
  return flow;
}
