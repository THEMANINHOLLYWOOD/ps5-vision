// The bridge's handling of sessions ending, with a stand-in for the console.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import ndc from 'node-datachannel';

import { Bridge } from './bridge.js';

after(() => ndc.cleanup());

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Behaves like the helper: connects at once, and says goodbye when stopped.
class FakeSource extends EventEmitter {
  stopping = false;
  inputPackets = 0;
  connects = true;
  start() { if (this.connects) queueMicrotask(() => this.emit('event', { type: 'connected' })); }
  stop() {
    if (this.stopping) return;
    this.stopping = true;
    queueMicrotask(() => this.end('Stopped', ''));
  }
  // The session ends, for the given reason, the way the helper reports it.
  end(reason, detail, error = false) {
    this.emit('event', { type: 'quit', reason, detail, error });
    this.emit('exit', { code: 0, signal: null });
  }
  sendController() {}
  requestKeyframe() {}
  sendPin() {}
}

// What the PS5 reported, word for word, when its own controller turned on.
// It is not flagged as an error.
const KICKED = ['Remote has disconnected from Stream Connection the because Server shut down', 'Server shutting down'];

// refuseAfterFirst: sessions after the first never get as far as connecting.
async function watching({ consoleState = 'ready', refuseAfterFirst = false } = {}) {
  const sources = [];
  const told = [];
  const bridge = new Bridge({
    console: { name: 'PS5-test', host: '192.0.2.1', registKey: '00', morning: '00', ps5: true },
    helperPath: '/nonexistent',
    reach: {
      locate: async () => ({ reply: { state: 'ready', address: '192.0.2.1', id: '' }, moved: false }),
      discover: async () => [{ state: consoleState, address: '192.0.2.1', id: '' }],
      wirelessDisplay: async () => null,
      createSource: () => {
        const source = new FakeSource();
        source.connects = !(refuseAfterFirst && sources.length > 0);
        sources.push(source);
        return source;
      },
    },
  });
  await bridge.connect({});
  const viewer = bridge.viewer;
  viewer.sendControl = (message) => told.push(message);
  viewer.emit('open'); // as if the browser had finished connecting
  await wait(50);
  assert.equal(sources.length, 1);
  assert.equal(told.at(-1).state, 'streaming');
  return { bridge, viewer, sources, told };
}

test('when the PS5\'s own controller turns on, the stream is joined again', async () => {
  const { bridge, sources, told } = await watching();
  sources[0].end(...KICKED);
  await wait(50);
  assert.equal(told.at(-1).state, 'rejoining');
  assert.ok(!told.some((message) => message.type === 'ended'), 'the browser is not told the game is over');
  await wait(3000);
  assert.equal(sources.length, 2, 'a new session was started');
  assert.equal(told.at(-1).state, 'streaming');
  bridge.shutdown();
});

test('when the PS5 really went to sleep, the page is told so', async () => {
  const { bridge, sources, told } = await watching({ consoleState: 'standby' });
  sources[0].end(...KICKED);
  await wait(3000);
  assert.equal(sources.length, 1);
  assert.deepEqual(told.at(-1), { type: 'ended', error: false, message: 'The PS5 was turned off or put into rest mode.' });
  bridge.shutdown();
});

test('ending the session from the page does not join again', async () => {
  const { bridge, viewer, sources, told } = await watching();
  viewer.emit('control', { type: 'stop', sleep: false });
  await wait(3000);
  assert.equal(sources.length, 1);
  assert.equal(told.at(-1).type, 'ended');
  bridge.shutdown();
});

test('a rejoin the console turns away at first is tried again', async () => {
  const { bridge, sources, told } = await watching({ refuseAfterFirst: true });
  sources[0].end(...KICKED);
  await wait(2700);
  assert.equal(sources.length, 2);
  // Too soon for the console: it refuses, flagged as an error this time.
  sources[1].end('Session request failed: Connection refused', '', true);
  await wait(4300);
  assert.equal(sources.length, 3, 'another try was made');
  assert.ok(!told.some((message) => message.type === 'ended'));
  bridge.shutdown();
});
