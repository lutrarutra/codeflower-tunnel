import assert from 'node:assert/strict';
import test from 'node:test';
import * as hub from '../src/hub.ts';

interface FakePeer extends hub.Peer {
  sent: Array<string | ArrayBuffer>;
  closedWith?: { code: number; reason: string };
}

function fakePeer(role: hub.Role, stream?: string, openedAt = 0): FakePeer {
  const peer: FakePeer = {
    info: { role, stream, openedAt },
    sent: [],
    send(data) {
      peer.sent.push(data);
    },
    close(code, reason) {
      peer.closedWith = { code, reason };
    }
  };
  return peer;
}

function peerSet(): hub.Peers & { list: hub.Peer[] } {
  const list: hub.Peer[] = [];
  return { list, add: (peer) => list.push(peer), all: () => list };
}

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
// Read through functions: assertions on a peer narrow its fields' types.
const frame = (peer: FakePeer, index: number) => new Uint8Array(peer.sent[index] as ArrayBuffer);
const closeCodeOf = (peer: FakePeer) => peer.closedWith?.code;

/** A connector with its control socket and one open, paired stream. */
function pairedStream() {
  const peers = peerSet();
  const control = fakePeer('control');
  hub.attachControl(peers, control);
  const browser = fakePeer('browser');
  assert.equal(
    hub.openStream(peers, browser, () => 's1'),
    true
  );
  const connector = fakePeer('connector', 's1');
  assert.equal(hub.attachConnectorStream(peers, connector), true);
  return { peers, control, browser, connector };
}

test('a browser stream asks the connector to dial back, then frames pass unchanged', () => {
  const { peers, control, browser, connector } = pairedStream();
  assert.deepEqual(control.sent, ['{"type":"open","stream":"s1"}']);
  assert.deepEqual(browser.sent, ['{"type":"ready"}']);

  hub.message(peers, browser, bytes(1, 2, 3));
  hub.message(peers, connector, bytes(4));
  assert.deepEqual(frame(connector, 0), new Uint8Array([1, 2, 3]));
  assert.deepEqual(frame(browser, 1), new Uint8Array([4]));
});

test('the open message carries the browser\'s address when known', () => {
  const peers = peerSet();
  const control = fakePeer('control');
  hub.attachControl(peers, control);
  const browser = fakePeer('browser');
  browser.info.ip = '203.0.113.4';
  hub.openStream(peers, browser, () => 's1');
  assert.deepEqual(control.sent, ['{"type":"open","stream":"s1","ip":"203.0.113.4"}']);
});

test('a stream to an offline connector is closed with 4404', () => {
  const peers = peerSet();
  const browser = fakePeer('browser');
  assert.equal(hub.openStream(peers, browser), false);
  assert.equal(browser.closedWith?.code, hub.CLOSE.offline);
  assert.equal(hub.isOnline(peers), false);
});

test('a new control socket replaces the old one, which gets no more streams', () => {
  const peers = peerSet();
  const old = fakePeer('control');
  hub.attachControl(peers, old);
  const fresh = fakePeer('control');
  hub.attachControl(peers, fresh);
  assert.equal(old.closedWith?.code, hub.CLOSE.replaced);

  hub.openStream(peers, fakePeer('browser'), () => 's1');
  assert.equal(old.sent.length, 0);
  assert.equal(fresh.sent.length, 1);
});

test('text frames and oversized frames close both ends', () => {
  const text = pairedStream();
  hub.message(text.peers, text.browser, 'hello');
  assert.equal(text.browser.closedWith?.code, hub.CLOSE.textFrame);
  assert.equal(text.connector.closedWith?.code, hub.CLOSE.textFrame);

  const big = pairedStream();
  hub.message(big.peers, big.connector, new ArrayBuffer(hub.MAX_FRAME + 1));
  assert.equal(big.browser.closedWith?.code, hub.CLOSE.tooBig);
  assert.equal(big.connector.closedWith?.code, hub.CLOSE.tooBig);
});

test('closing one end closes the other with the same code; unsendable codes become 1000', () => {
  const first = pairedStream();
  hub.closed(first.peers, first.connector, 4321, 'bye');
  assert.deepEqual(first.browser.closedWith, { code: 4321, reason: 'bye' });

  const second = pairedStream();
  hub.closed(second.peers, second.browser, 1006, '');
  assert.equal(second.connector.closedWith?.code, 1000);
});

test('a connector stream nobody waits for is refused', () => {
  const { peers } = pairedStream();
  const stray = fakePeer('connector', 'unknown');
  assert.equal(hub.attachConnectorStream(peers, stray), false);
  const twice = fakePeer('connector', 's1');
  assert.equal(hub.attachConnectorStream(peers, twice), false);
});

test('browsers whose connector does not dial back are closed after the timeout', () => {
  const peers = peerSet();
  hub.attachControl(peers, fakePeer('control'));
  const browser = fakePeer('browser', undefined, 1000);
  hub.openStream(peers, browser);
  assert.equal(hub.sweep(peers, 1000 + hub.DIAL_BACK_MS - 1), 1);
  assert.equal(browser.closedWith, undefined);
  assert.equal(hub.sweep(peers, 1000 + hub.DIAL_BACK_MS), 0);
  assert.equal(closeCodeOf(browser), hub.CLOSE.timeout);
});

test('streams per connector are limited', () => {
  const peers = peerSet();
  hub.attachControl(peers, fakePeer('control'));
  let id = 0;
  for (let i = 0; i < hub.MAX_STREAMS; i++) assert.equal(hub.openStream(peers, fakePeer('browser'), () => `s${id++}`), true);
  const extra = fakePeer('browser');
  assert.equal(hub.openStream(peers, extra), false);
  assert.equal(extra.closedWith?.code, hub.CLOSE.tooMany);
});

test('revoking closes every socket with 4401', () => {
  const { peers, control, browser, connector } = pairedStream();
  hub.disconnectAll(peers, 'revoked');
  for (const peer of [control, browser, connector]) assert.equal(peer.closedWith?.code, hub.CLOSE.unauthorized);
});
