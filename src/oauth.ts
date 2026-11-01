// GitHub's and Google's OAuth code flows, with fetch and WebCrypto only.
// Google uses PKCE; GitHub OAuth apps do too, so both send a verifier.

import { base64url, randomToken } from './crypto.ts';
import type { OAuthClient } from './config.ts';

export type Provider = 'github' | 'google';

interface Endpoints {
  authorize: string;
  token: string;
  scopes: string[];
}

const endpoints: Record<Provider, Endpoints> = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user']
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'profile']
  }
};

/**
 * What makes the provider ask the user again instead of answering at once
 * for a browser already signed in, to confirm an action: GitHub's account
 * picker, and for Google the picker and a fresh sign-in (OIDC max_age=0).
 */
export const CONFIRM_PROMPT: Record<Provider, Record<string, string>> = {
  github: { prompt: 'select_account' },
  google: { prompt: 'select_account', max_age: '0' }
};

export const generateState = (): string => randomToken();
export const generateCodeVerifier = (): string => randomToken();

async function challenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function authorizationUrl(
  provider: Provider,
  client: OAuthClient,
  redirectUri: string,
  state: string,
  verifier: string,
  /** More parameters, e.g. prompt= to make the user sign in again. */
  extra: Record<string, string> = {}
): Promise<URL> {
  const { authorize, scopes } = endpoints[provider];
  const url = new URL(authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
  return url;
}

export interface Tokens {
  access_token: string;
  id_token?: string;
}

/** Exchanges the code from the callback for tokens. */
export async function exchangeCode(
  provider: Provider,
  client: OAuthClient,
  redirectUri: string,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch
): Promise<Tokens> {
  const response = await fetcher(endpoints[provider].token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: verifier
    })
  });
  // GitHub reports errors with status 200 and an `error` field.
  const body = (await response.json().catch(() => ({}))) as Partial<Tokens> & { error?: string };
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(`${provider} token exchange failed: ${body.error ?? response.status}`);
  }
  return body as Tokens;
}

/** The claims of an ID token received straight from the provider's token endpoint. */
export function idTokenClaims(idToken: string): Record<string, unknown> {
  const [, payload] = idToken.split('.');
  if (!payload) throw new Error('Malformed ID token');
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (char) => char.charCodeAt(0))));
}
