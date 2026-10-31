// WebCrypto helpers, the same on Workers and Node.

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A random, URL-safe secret of `bytes` bytes. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

const lowerAlphabet = 'abcdefghijklmnopqrstuvwxyz234567';

/** A random lowercase ID, safe in paths and host names (base32, 130 bits). */
export function randomId(): string {
  return Array.from(randomBytes(26), (byte) => lowerAlphabet[byte & 31]).join('');
}

// No 0/O, 1/I/L: people type these.
const userCodeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A code people type, like ABCD-EFGH. */
export function userCode(): string {
  // 256 is not a multiple of the alphabet's 31 letters: drop the bytes that would skew it.
  const letters: string[] = [];
  while (letters.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && letters.length < 8) letters.push(userCodeAlphabet[byte % 31]);
    }
  }
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ]);
}

/** `payload.signature`, both base64url. */
export async function sign(secret: string, payload: unknown): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body)));
  return `${body}.${base64url(signature)}`;
}

/** The payload of a value from `sign`, or undefined if it was altered. Constant-time. */
export async function verify<T>(secret: string, value: string | undefined): Promise<T | undefined> {
  if (!value) return undefined;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) return undefined;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64url(signature),
      encoder.encode(body)
    );
    return valid ? (JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T) : undefined;
  } catch {
    return undefined;
  }
}
