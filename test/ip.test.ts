import assert from 'node:assert/strict';
import test from 'node:test';
import { inRanges, normalizeAddress, parseRange } from '../src/ip.ts';

const ranges = (...entries: string[]) => entries.map((entry) => parseRange(entry)!);

test('addresses are written the usual way; IPv4-mapped ones as IPv4', () => {
  assert.equal(normalizeAddress('203.0.113.4'), '203.0.113.4');
  assert.equal(normalizeAddress('::ffff:203.0.113.4'), '203.0.113.4');
  assert.equal(normalizeAddress('::FFFF:cb00:7104'), '203.0.113.4');
  assert.equal(normalizeAddress('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(normalizeAddress('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeAddress('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeAddress('2001:db8:0:1:0:0:0:1'), '2001:db8:0:1::1');
  assert.equal(normalizeAddress('::'), '::');
  assert.equal(normalizeAddress('::1'), '::1');
  for (const bad of ['', '256.0.0.1', '1.2.3', '1:2:3:4:5:6:7:8:9', '1::2::3', 'x::1', '01.02.03.04.05', 'unknown']) {
    assert.equal(normalizeAddress(bad), undefined, bad);
  }
});

test('ranges match addresses of their family', () => {
  const allowed = ranges('10.0.0.0/8', '192.168.1.7', '2001:db8::/32', '0.0.0.0/0');
  assert.equal(inRanges('10.255.0.1', allowed.slice(0, 1)), true);
  assert.equal(inRanges('11.0.0.1', allowed.slice(0, 1)), false);
  assert.equal(inRanges('192.168.1.7', allowed.slice(1, 2)), true);
  assert.equal(inRanges('192.168.1.8', allowed.slice(1, 2)), false);
  assert.equal(inRanges('2001:db8:ffff::1', allowed.slice(2, 3)), true);
  assert.equal(inRanges('2001:db9::1', allowed.slice(2, 3)), false);
  assert.equal(inRanges('::ffff:10.0.0.1', allowed.slice(0, 1)), true);
  // 0.0.0.0/0 admits all of IPv4 but no IPv6.
  assert.equal(inRanges('203.0.113.4', allowed.slice(3)), true);
  assert.equal(inRanges('2001:db8::1', allowed.slice(3)), false);
  assert.equal(inRanges('not an address', allowed), false);
});

test('bad ranges are refused', () => {
  for (const bad of ['10.0.0.0/33', '2001:db8::/129', '10.0.0.0/x', '10.0.0.0/8/8', '/8', 'example.org']) {
    assert.equal(parseRange(bad), undefined, bad);
  }
});
