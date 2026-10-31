// Client addresses and the allowlist (ALLOWED_IPS): IPv4 and IPv6 addresses
// and CIDR ranges. An IPv4-mapped IPv6 address (::ffff:203.0.113.4) counts as
// its IPv4 address, which is how Node reports IPv4 clients on a dual-stack socket.

interface Address {
  v6: boolean;
  value: bigint;
}

export interface Range {
  v6: boolean;
  value: bigint;
  bits: number;
}

function parseV4(text: string): bigint | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function parseV6(text: string): bigint | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string) => (half === '' ? [] : half.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  // A trailing dotted IPv4 part fills the last two groups.
  const last = (halves.length === 2 ? tail : head).at(-1);
  if (last?.includes('.')) {
    const v4 = parseV4(last);
    if (v4 === undefined) return undefined;
    (halves.length === 2 ? tail : head).splice(-1, 1, (v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  let value = 0n;
  for (const group of [...head, ...Array<string>(missing).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

const MAPPED = 0xffffn << 32n;

export function parseAddress(text: string): Address | undefined {
  const plain = text.trim().replace(/^\[(.*)\]$/, '$1');
  const v4 = parseV4(plain);
  if (v4 !== undefined) return { v6: false, value: v4 };
  const v6 = parseV6(plain.replace(/%.*$/, ''));
  if (v6 === undefined) return undefined;
  if (v6 >> 32n === 0xffffn) return { v6: false, value: v6 - MAPPED };
  return { v6: true, value: v6 };
}

/** An address or CIDR range, e.g. `203.0.113.0/24` or `2001:db8::/32`. */
export function parseRange(text: string): Range | undefined {
  const [address, prefix, ...rest] = text.trim().split('/');
  const parsed = rest.length === 0 && address ? parseAddress(address) : undefined;
  if (!parsed) return undefined;
  const max = parsed.v6 ? 128 : 32;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return undefined;
  const bits = prefix === undefined ? max : Number(prefix);
  if (bits > max) return undefined;
  return { ...parsed, bits };
}

/** The address, written the usual way (IPv4-mapped addresses as IPv4), or undefined if it is not one. */
export function normalizeAddress(text: string): string | undefined {
  const address = parseAddress(text);
  if (!address) return undefined;
  if (!address.v6) return [24n, 16n, 8n, 0n].map((shift) => (address.value >> shift) & 0xffn).join('.');
  const groups = [...Array(8).keys()].map((index) => ((address.value >> BigInt(112 - 16 * index)) & 0xffffn).toString(16));
  // RFC 5952: the longest run of two or more zero groups becomes `::`.
  let best = { start: -1, length: 1 };
  for (let start = 0; start < 8; start++) {
    let length = 0;
    while (groups[start + length] === '0') length++;
    if (length > best.length) best = { start, length };
  }
  if (best.start < 0) return groups.join(':');
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.length).join(':')}`;
}

export function inRanges(text: string, ranges: Range[]): boolean {
  const address = parseAddress(text);
  if (!address) return false;
  return ranges.some((range) => {
    if (range.v6 !== address.v6) return false;
    const shift = BigInt((range.v6 ? 128 : 32) - range.bits);
    return address.value >> shift === range.value >> shift;
  });
}
