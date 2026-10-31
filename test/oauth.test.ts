import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationUrl, exchangeCode, idTokenClaims } from '../src/oauth.ts';

const client = { clientId: 'id', clientSecret: 'secret' };

test('authorization URLs carry the state and a PKCE S256 challenge (RFC 7636 appendix B)', async () => {
  const url = await authorizationUrl('google', client, 'https://t.example/cb', 'st', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('scope'), 'openid profile');
});

test('a token exchange that GitHub refuses with status 200 still fails', async () => {
  const fake = (async () => Response.json({ error: 'bad_verification_code' })) as typeof fetch;
  await assert.rejects(exchangeCode('github', client, 'https://t.example/cb', 'code', 'v', fake), /bad_verification_code/);
  const ok = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URLSearchParams(init?.body as URLSearchParams).get('code_verifier'), 'v');
    return Response.json({ access_token: 'token' });
  }) as typeof fetch;
  assert.equal((await exchangeCode('github', client, 'https://t.example/cb', 'code', 'v', ok)).access_token, 'token');
});

test('ID token claims are read from the payload, including non-ASCII names', () => {
  const payload = Buffer.from(JSON.stringify({ sub: '1', name: 'Zoë' })).toString('base64url');
  assert.deepEqual(idTokenClaims(`h.${payload}.s`), { sub: '1', name: 'Zoë' });
});
