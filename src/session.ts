// Signed cookies instead of a session table: the session cookie names the
// user, and short-lived flow cookies carry OAuth state and passkey challenges.
// Rotating COOKIE_SECRET signs everyone out.

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { securePrefix, type Config } from './config.ts';
import { sign, verify } from './crypto.ts';

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

export async function signIn(c: Context, config: Config, userId: string): Promise<void> {
  await write(c, config, 'cft_session', { u: userId }, SESSION_DAYS * 24 * 3600);
}

export function signOut(c: Context, config: Config): void {
  remove(c, config, 'cft_session');
}

export async function sessionUser(c: Context, config: Config): Promise<string | undefined> {
  return (await read<Signed & { u: string }>(c, config, 'cft_session'))?.u;
}

/** State of a sign-in in progress (OAuth redirect, passkey ceremony), valid 10 minutes. */
export async function writeFlow(c: Context, config: Config, flow: object): Promise<void> {
  await write(c, config, 'cft_flow', flow, 600);
}

/** Reads and removes the flow state: each one is used once. */
export async function takeFlow<T extends object>(c: Context, config: Config): Promise<T | undefined> {
  const flow = await read<Signed & T>(c, config, 'cft_flow');
  remove(c, config, 'cft_flow');
  return flow;
}
