// The tunnel's settings, read from environment variables on both platforms:
// Worker bindings and secrets on Cloudflare, process.env when self-hosted.

import { parseRange, type Range } from './ip.ts';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  /** Where browsers reach the tunnel, e.g. https://tunnel.example.org. */
  publicUrl: URL;
  /** Signs cookies. At least 32 characters. */
  cookieSecret: string;
  github?: OAuthClient;
  google?: OAuthClient;
  /** The passkeys' relying party: the tunnel's host name unless set. */
  webauthnRpId: string;
  /** GitHub accounts without two-factor authentication are refused unless this is false. */
  requireGithub2fa: boolean;
  /** Browsers may open streams only from these addresses and ranges; empty admits all. */
  allowedIps: Range[];
  /** Self-hosted behind a reverse proxy: the header it puts the client's address in. */
  clientIpHeader?: string;
}

export type Env = Record<string, unknown>;

function text(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function client(env: Env, prefix: string): OAuthClient | undefined {
  const clientId = text(env, `${prefix}_CLIENT_ID`);
  const clientSecret = text(env, `${prefix}_CLIENT_SECRET`);
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error(`Set both ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET`);
  return { clientId, clientSecret };
}

function ranges(env: Env, name: string): Range[] {
  return (text(env, name) ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const range = parseRange(entry);
      if (!range) throw new Error(`${name}: "${entry}" is not an IP address or CIDR range`);
      return range;
    });
}

export function readConfig(env: Env): Config {
  const url = text(env, 'PUBLIC_URL');
  if (!url) throw new Error('Set PUBLIC_URL, e.g. https://tunnel.example.org');
  const publicUrl = new URL(url);
  const cookieSecret = text(env, 'COOKIE_SECRET');
  if (!cookieSecret || cookieSecret.length < 32) throw new Error('Set COOKIE_SECRET to at least 32 random characters');
  return {
    publicUrl,
    cookieSecret,
    github: client(env, 'GITHUB'),
    google: client(env, 'GOOGLE'),
    webauthnRpId: text(env, 'WEBAUTHN_RP_ID') ?? publicUrl.hostname,
    requireGithub2fa: text(env, 'REQUIRE_GITHUB_2FA') !== 'false',
    allowedIps: ranges(env, 'ALLOWED_IPS'),
    clientIpHeader: text(env, 'CLIENT_IP_HEADER')
  };
}

/** Secure cookies need https, except on localhost, which browsers treat as secure. */
export function securePrefix(config: Config): boolean {
  return config.publicUrl.protocol === 'https:';
}
