// Signing in: GitHub, Google or a passkey. An identity is linked to an
// account only while signed in to it, never by matching email addresses,
// which would let anyone who controls an address take the account over.

import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import type { Config } from './config.ts';
import { randomId } from './crypto.ts';
import { schema, type Db } from './db/index.ts';
import { authorizationUrl, exchangeCode, generateCodeVerifier, generateState, idTokenClaims, type Provider } from './oauth.ts';
import { sessionUser, signIn, signOut, takeFlow, writeFlow } from './session.ts';

interface OAuthFlow {
  kind: 'oauth';
  provider: Provider;
  state: string;
  verifier: string;
}

interface PasskeyFlow {
  kind: 'passkey';
  mode: 'register' | 'login';
  challenge: string;
  /** For a new account: the ID the passkey was created for. */
  newUserId?: string;
}

export class AuthError extends Error {}

function redirectUri(config: Config, provider: Provider): string {
  return new URL(`/auth/${provider}/callback`, config.publicUrl).toString();
}

async function createUser(db: Db, displayName: string, id = randomId()): Promise<string> {
  await db.insert(schema.users).values({ id, displayName: displayName.slice(0, 100) || 'code flower user', createdAt: Date.now() });
  return id;
}

/**
 * The account an identity signs in to: its own if it has one, else the
 * signed-in account (linking it), else a new account.
 */
async function accountFor(db: Db, current: string | undefined, provider: Provider, subject: string, name: string): Promise<string> {
  const [known] = await db
    .select()
    .from(schema.identities)
    .where(and(eq(schema.identities.provider, provider), eq(schema.identities.subject, subject)));
  if (known) {
    if (current && known.userId !== current) throw new AuthError('This account is already linked to another code flower account.');
    return known.userId;
  }
  const userId = current ?? (await createUser(db, name));
  await db.insert(schema.identities).values({ provider, subject, userId, createdAt: Date.now() });
  return userId;
}

async function githubIdentity(config: Config, accessToken: string): Promise<{ subject: string; name: string }> {
  const response = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'codeflower-tunnel', Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) throw new AuthError('GitHub did not return the account.');
  const user = (await response.json()) as { id: number; login: string; name?: string; two_factor_authentication?: boolean };
  if (config.requireGithub2fa && user.two_factor_authentication !== true) {
    throw new AuthError('Turn on two-factor authentication for your GitHub account, then sign in again.');
  }
  return { subject: String(user.id), name: user.name || user.login };
}

function googleIdentity(config: Config, idToken: string): { subject: string; name: string } {
  // The token came straight from Google's token endpoint over TLS, in exchange
  // for our code and secret, so its signature need not be checked (OIDC 3.1.3.7).
  const claims = idTokenClaims(idToken) as { sub: string; aud: string; iss: string; name?: string };
  if (claims.aud !== config.google?.clientId || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) {
    throw new AuthError('Google returned a token for another application.');
  }
  return { subject: claims.sub, name: claims.name ?? 'Google user' };
}

export function authRoutes(app: Hono, config: Config, getDb: (c: Context) => Db): void {
  const rpName = 'code flower tunnel';
  const expectedOrigin = config.publicUrl.origin;

  const failed = (c: Context, error: unknown) => {
    const message = error instanceof AuthError ? error.message : 'Signing in failed. Please try again.';
    if (!(error instanceof AuthError)) console.error('sign-in failed', error);
    return c.redirect(`/?error=${encodeURIComponent(message)}`);
  };

  app.get('/auth/:provider{github|google}', async (c) => {
    const provider = c.req.param('provider') as Provider;
    const client = config[provider];
    if (!client) return c.notFound();
    const state = generateState();
    const verifier = generateCodeVerifier();
    const url = await authorizationUrl(provider, client, redirectUri(config, provider), state, verifier);
    await writeFlow(c, config, { kind: 'oauth', provider, state, verifier } satisfies OAuthFlow);
    return c.redirect(url.toString());
  });

  app.get('/auth/:provider{github|google}/callback', async (c) => {
    const provider = c.req.param('provider') as Provider;
    const flow = await takeFlow<OAuthFlow>(c, config);
    const code = c.req.query('code');
    if (!flow || flow.kind !== 'oauth' || flow.provider !== provider || !code || c.req.query('state') !== flow.state) {
      return failed(c, new AuthError('The sign-in expired or was started elsewhere. Please try again.'));
    }
    try {
      const client = config[provider];
      if (!client) return c.notFound();
      const tokens = await exchangeCode(provider, client, redirectUri(config, provider), code, flow.verifier);
      const identity =
        provider === 'github'
          ? await githubIdentity(config, tokens.access_token)
          : googleIdentity(config, tokens.id_token ?? '');
      const db = getDb(c);
      const userId = await accountFor(db, await sessionUser(c, config), provider, identity.subject, identity.name);
      await signIn(c, config, userId);
      return c.redirect('/');
    } catch (error) {
      return failed(c, error);
    }
  });

  app.post('/auth/logout', (c) => {
    signOut(c, config);
    return c.json({ ok: true });
  });

  // Passkeys. Signed out, registering one creates a new account.
  app.post('/auth/passkey/register/options', async (c) => {
    const db = getDb(c);
    const current = await sessionUser(c, config);
    const [user] = current ? await db.select().from(schema.users).where(eq(schema.users.id, current)) : [];
    const newUserId = user ? undefined : randomId();
    const existing = user ? await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user.id)) : [];
    const options = await generateRegistrationOptions({
      rpName,
      rpID: config.webauthnRpId,
      userName: user?.displayName ?? 'code flower',
      userID: new TextEncoder().encode(user?.id ?? newUserId),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: existing.map((key) => ({ id: key.id }))
    });
    await writeFlow(c, config, { kind: 'passkey', mode: 'register', challenge: options.challenge, newUserId } satisfies PasskeyFlow);
    return c.json(options);
  });

  app.post('/auth/passkey/register/verify', async (c) => {
    const flow = await takeFlow<PasskeyFlow>(c, config);
    if (!flow || flow.kind !== 'passkey' || flow.mode !== 'register') return c.json({ error: 'The request expired. Please try again.' }, 400);
    const db = getDb(c);
    const current = await sessionUser(c, config);
    try {
      const verification = await verifyRegistrationResponse({
        response: await c.req.json(),
        expectedChallenge: flow.challenge,
        expectedOrigin,
        expectedRPID: config.webauthnRpId,
        requireUserVerification: true
      });
      if (!verification.verified) return c.json({ error: 'The passkey could not be verified.' }, 400);
      const { credential } = verification.registrationInfo;
      const userId = current ?? (flow.newUserId && (await createUser(db, 'Passkey user', flow.newUserId)));
      if (!userId) return c.json({ error: 'The request expired. Please try again.' }, 400);
      await db.insert(schema.passkeys).values({
        id: credential.id,
        userId,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports?.join(',') ?? null,
        createdAt: Date.now()
      });
      await signIn(c, config, userId);
      return c.json({ ok: true });
    } catch (error) {
      console.error('passkey registration failed', error);
      return c.json({ error: 'The passkey could not be verified.' }, 400);
    }
  });

  app.post('/auth/passkey/login/options', async (c) => {
    const options = await generateAuthenticationOptions({ rpID: config.webauthnRpId, userVerification: 'required' });
    await writeFlow(c, config, { kind: 'passkey', mode: 'login', challenge: options.challenge } satisfies PasskeyFlow);
    return c.json(options);
  });

  app.post('/auth/passkey/login/verify', async (c) => {
    const flow = await takeFlow<PasskeyFlow>(c, config);
    if (!flow || flow.kind !== 'passkey' || flow.mode !== 'login') return c.json({ error: 'The request expired. Please try again.' }, 400);
    const db = getDb(c);
    const response = await c.req.json();
    const [key] = await db.select().from(schema.passkeys).where(eq(schema.passkeys.id, String(response?.id ?? '')));
    if (!key) return c.json({ error: 'This passkey is not registered here.' }, 400);
    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin,
        expectedRPID: config.webauthnRpId,
        requireUserVerification: true,
        credential: {
          id: key.id,
          publicKey: new Uint8Array(key.publicKey),
          counter: key.counter,
          transports: key.transports ? (key.transports.split(',') as AuthenticatorTransport[]) : undefined
        }
      });
      if (!verification.verified) return c.json({ error: 'The passkey could not be verified.' }, 400);
      await db
        .update(schema.passkeys)
        .set({ counter: verification.authenticationInfo.newCounter })
        .where(eq(schema.passkeys.id, key.id));
      await signIn(c, config, key.userId);
      return c.json({ ok: true });
    } catch (error) {
      console.error('passkey sign-in failed', error);
      return c.json({ error: 'The passkey could not be verified.' }, 400);
    }
  });
}
