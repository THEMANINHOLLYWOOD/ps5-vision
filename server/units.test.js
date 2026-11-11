import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameParser, encodeFrame } from './framing.js';
import { AccessUnitSplitter, hasParameterSets, isKeyframe, nalTypes } from './h264.js';
import { OggOpusReader } from './ogg.js';
import { broadcastAddresses, parseDiscoveryResponse, wakeCredential } from './discovery.js';
import { describeQuit, normalizeOptions } from './bridge.js';
import { BUTTON, encodeState, idleState, readGamepad, statesEqual } from '../web/controller.js';

// ---------------------------------------------------------------- framing

test('frames survive being split at every possible byte boundary', () => {
  const frames = [
    ['E', Buffer.from('{"type":"connected"}')],
    ['V', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])],
    ['I', Buffer.alloc(0)],
    ['A', Buffer.from([0xff])],
  ];
  const wire = Buffer.concat(frames.map(([type, payload]) => encodeFrame(type, payload)));
  for (let cut = 1; cut < wire.length; cut++) {
    const seen = [];
    const parser = new FrameParser((type, payload) => seen.push([type, Buffer.from(payload)]));
    parser.push(wire.subarray(0, cut));
    parser.push(wire.subarray(cut));
    assert.deepEqual(seen, frames, `cut at ${cut}`);
  }
});

test('a frame claiming an absurd length is rejected instead of buffered forever', () => {
  const parser = new FrameParser(() => {}, { maxPayload: 16 });
  const head = Buffer.from([0x56, 0xff, 0xff, 0xff, 0x7f]);
  assert.throws(() => parser.push(head), /exceeds limit/);
});

// ------------------------------------------------------------------ h264

const SPS = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a]);
const PPS = Buffer.from([0, 0, 0, 1, 0x68, 0xee, 0x3c]);
const IDR = Buffer.from([0, 0, 1, 0x65, 0x88, 0x84]);
const SLICE = Buffer.from([0, 0, 1, 0x41, 0x9a, 0x02]);
const AUD = Buffer.from([0, 0, 0, 1, 0x09, 0xf0]);

test('NAL types are read with both 3- and 4-byte start codes', () => {
  assert.deepEqual(nalTypes(Buffer.concat([SPS, PPS, IDR, SLICE])), [7, 8, 5, 1]);
});

test('only a buffer containing an IDR slice counts as a keyframe', () => {
  assert.equal(isKeyframe(Buffer.concat([SPS, PPS, IDR])), true);
  assert.equal(isKeyframe(IDR), true);
  assert.equal(isKeyframe(SLICE), false);
  assert.equal(isKeyframe(Buffer.concat([SPS, PPS])), false);
});

test('parameter sets need both SPS and PPS', () => {
  assert.equal(hasParameterSets(Buffer.concat([SPS, PPS, IDR])), true);
  assert.equal(hasParameterSets(Buffer.concat([SPS, IDR])), false);
  assert.equal(hasParameterSets(IDR), false);
});

test('a byte stream is split into access units at delimiters, however it is chunked', () => {
  const unit1 = Buffer.concat([AUD, SPS, PPS, IDR]);
  const unit2 = Buffer.concat([AUD, SLICE]);
  const unit3 = Buffer.concat([AUD, SLICE, SLICE]);
  const stream = Buffer.concat([unit1, unit2, unit3]);
  for (const chunkSize of [1, 2, 3, 5, 7, stream.length]) {
    const units = [];
    const splitter = new AccessUnitSplitter((unit) => units.push(Buffer.from(unit)));
    for (let i = 0; i < stream.length; i += chunkSize) splitter.push(stream.subarray(i, i + chunkSize));
    splitter.flush();
    assert.deepEqual(units, [unit1, unit2, unit3], `chunk size ${chunkSize}`);
  }
});

// ------------------------------------------------------------------- ogg

function oggPage(packets) {
  const segments = [];
  for (const packet of packets) {
    let left = packet.length;
    while (left >= 255) { segments.push(255); left -= 255; }
    segments.push(left);
  }
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments), ...packets]);
}

test('Opus packets are extracted and the two Ogg header packets skipped', () => {
  const big = Buffer.alloc(600, 7); // spans three lacing segments
  const small = Buffer.from([1, 2, 3]);
  const stream = Buffer.concat([
    oggPage([Buffer.from('OpusHead........')]),
    oggPage([Buffer.from('OpusTags........')]),
    oggPage([small]),
    oggPage([big, small]),
  ]);
  for (const chunkSize of [1, 13, 300, stream.length]) {
    const packets = [];
    const reader = new OggOpusReader((packet) => packets.push(Buffer.from(packet)));
    for (let i = 0; i < stream.length; i += chunkSize) reader.push(stream.subarray(i, i + chunkSize));
    assert.deepEqual(packets, [small, big, small], `chunk size ${chunkSize}`);
  }
});

// ------------------------------------------------------------- discovery

test('a console that is on reports ready, with its name', () => {
  const reply = 'HTTP/1.1 200 Ok\nhost-id:AABBCCDDEEFF\nhost-type:PS5\nhost-name:Living Room\nhost-request-port:997\nsystem-version:14000000\n';
  assert.deepEqual(parseDiscoveryResponse(reply, '192.168.1.20'), {
    address: '192.168.1.20',
    state: 'ready',
    code: 200,
    name: 'Living Room',
    type: 'PS5',
    id: 'AABBCCDDEEFF',
    systemVersion: '14000000',
    runningApp: '',
  });
});

test('a console in rest mode reports standby', () => {
  const parsed = parseDiscoveryResponse('HTTP/1.1 620 Server Standby\nhost-type:PS5\n', '10.0.0.5');
  assert.equal(parsed.state, 'standby');
});

test('text that is not a discovery reply is ignored', () => {
  assert.equal(parseDiscoveryResponse('SRCH * HTTP/1.1\n', '10.0.0.5'), null);
  assert.equal(parseDiscoveryResponse('', '10.0.0.5'), null);
});

test('the wake credential is the registration key text read as hexadecimal', () => {
  // Key text "1a2b3c4d", NUL-padded to 16 bytes, stored as hex of those bytes.
  const stored = Buffer.concat([Buffer.from('1a2b3c4d'), Buffer.alloc(8)]).toString('hex');
  assert.equal(wakeCredential(stored), String(0x1a2b3c4d));
  assert.throws(() => wakeCredential(Buffer.from('not hex!').toString('hex')), /not hexadecimal/);
});

test('broadcast addresses follow each interface netmask', () => {
  const interfaces = {
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::' },
      { family: 'IPv4', internal: false, address: '192.168.5.10', netmask: '255.255.252.0' },
    ],
    en5: [{ family: 'IPv4', internal: false, address: '10.0.0.7', netmask: '255.255.255.0' }],
  };
  assert.deepEqual(broadcastAddresses(interfaces), ['192.168.7.255', '10.0.0.255']);
});

// ---------------------------------------------------------------- bridge

test('stream options fall back to safe values', () => {
  assert.deepEqual(normalizeOptions({}), { res: 1080, fps: 60, bitrate: 0 });
  assert.deepEqual(normalizeOptions({ res: 720, fps: 30, bitrate: 8000 }), { res: 720, fps: 30, bitrate: 8000 });
  assert.deepEqual(normalizeOptions({ res: 4320, fps: 240, bitrate: 9e9 }), { res: 1080, fps: 60, bitrate: 50000 });
  assert.deepEqual(normalizeOptions({ res: 'x', fps: null, bitrate: 'lots' }), { res: 1080, fps: 60, bitrate: 0 });
});

test('known session failures get a plain-language explanation', () => {
  assert.match(describeQuit('Remote Play on Console is already in use', ''), /Another device/);
  assert.match(describeQuit('RP-Version mismatch', ''), /system software is newer/);
  assert.equal(describeQuit('Something new', 'code 7'), 'Something new (code 7)');
  assert.equal(describeQuit('Something new', ''), 'Something new');
});

// ------------------------------------------------------------ controller

function pad({ pressed = [], values = {}, axes = [0, 0, 0, 0] } = {}) {
  const buttons = Array.from({ length: 18 }, (_, i) => ({
    pressed: pressed.includes(i) || (values[i] ?? 0) > 0,
    value: values[i] ?? (pressed.includes(i) ? 1 : 0),
  }));
  return { connected: true, mapping: 'standard', buttons, axes };
}

test('face buttons, d-pad and system buttons map to the console layout', () => {
  assert.equal(readGamepad(pad({ pressed: [0] })).buttons, BUTTON.CROSS);
  assert.equal(readGamepad(pad({ pressed: [1, 3] })).buttons, BUTTON.CIRCLE | BUTTON.TRIANGLE);
  assert.equal(readGamepad(pad({ pressed: [12, 15] })).buttons, BUTTON.DPAD_UP | BUTTON.DPAD_RIGHT);
  assert.equal(readGamepad(pad({ pressed: [8, 9, 16, 17] })).buttons,
    BUTTON.SHARE | BUTTON.OPTIONS | BUTTON.PS | BUTTON.TOUCHPAD);
});

test('triggers are analog and sticks use the full signed range', () => {
  const state = readGamepad(pad({ values: { 6: 0.5, 7: 1 }, axes: [-1, 1, 0.5, 0.01] }));
  assert.equal(state.l2, 128);
  assert.equal(state.r2, 255);
  assert.equal(state.lx, -32767);
  assert.equal(state.ly, 32767);
  assert.equal(state.rx, 16384);
  assert.equal(state.ry, 0, 'a stick at rest reads as centred');
  assert.equal(state.buttons, 0, 'triggers are not digital buttons');
});

test('on-screen buttons combine with the physical controller, or work alone', () => {
  assert.equal(readGamepad(pad({ pressed: [0] }), BUTTON.PS).buttons, BUTTON.CROSS | BUTTON.PS);
  assert.deepEqual(readGamepad(null, BUTTON.PS), { ...idleState(), buttons: BUTTON.PS });
});

test('state is encoded in the byte layout the helper reads', () => {
  const bytes = encodeState({ buttons: BUTTON.PS | BUTTON.CROSS, l2: 1, r2: 255, lx: -2, ly: 2, rx: 32767, ry: -32768 });
  assert.deepEqual([...bytes], [
    0x01, 0x80, 0x00, 0x00, // buttons
    0x01, 0xff,             // l2, r2
    0xfe, 0xff, 0x02, 0x00, // lx, ly
    0xff, 0x7f, 0x00, 0x80, // rx, ry
  ]);
});

test('state comparison notices any single field changing', () => {
  const base = readGamepad(pad());
  assert.equal(statesEqual(base, idleState()), true);
  for (const key of Object.keys(base)) {
    assert.equal(statesEqual(base, { ...base, [key]: 1 }), false, key);
  }
});

// --------------------------------------------------------------- linking

import { accountIdToHex, userIdToAccountId } from './link.js';

test('a PSN user ID becomes the base64 account ID other Remote Play tools print', () => {
  // 8 little-endian bytes of the number, base64 encoded.
  assert.equal(userIdToAccountId('1'), 'AQAAAAAAAAA=');
  assert.equal(userIdToAccountId('1311768467463790320'), Buffer.from('f0debc9a78563412', 'hex').toString('base64'));
});

test('an account ID round-trips to the hex the helper takes, and junk is refused', () => {
  assert.equal(accountIdToHex(userIdToAccountId('1311768467463790320')), 'f0debc9a78563412');
  assert.equal(accountIdToHex('  AQAAAAAAAAA=\n'), '0100000000000000');
  assert.throws(() => accountIdToHex('abc'), /not a PSN account ID/);
  assert.throws(() => accountIdToHex(''), /not a PSN account ID/);
});

// ---------------------------------------------------------------- access

test('only names this machine goes by are accepted as Host', async () => {
  const { hostAllowed, hostnameOf } = await import('./access.js');
  const allowed = ['localhost', '127.0.0.1', '[::1]', 'Some-Mac.local', '192.168.1.5'];
  assert.equal(hostnameOf('Some-Mac.local:8443'), 'some-mac.local');
  assert.equal(hostnameOf('[::1]:8080'), '[::1]');
  assert.ok(hostAllowed('some-mac.local:8443', allowed));
  assert.ok(hostAllowed('192.168.1.5:8080', allowed));
  assert.ok(hostAllowed('localhost', allowed));
  // A rebinding page sends its own domain, whatever address it resolved to.
  assert.ok(!hostAllowed('evil.example:8080', allowed));
  assert.ok(!hostAllowed('192.168.1.6:8080', allowed));
  assert.ok(!hostAllowed('localhost:8080@evil.example', allowed));
  assert.ok(!hostAllowed('', allowed));
  assert.ok(!hostAllowed(undefined, allowed));
});

test('the access code is created once, kept private, and compared exactly', async () => {
  const { codesMatch, loadOrCreateAccessCode } = await import('./access.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5-access-'));
  try {
    const file = path.join(dir, 'nested', 'access-code');
    const code = loadOrCreateAccessCode(file);
    assert.match(code, /^\d{6}$/);
    assert.equal(loadOrCreateAccessCode(file), code);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(codesMatch(code, code));
    assert.ok(!codesMatch(code === '000000' ? '000001' : '000000', code));
    assert.ok(!codesMatch(`${code}0`, code));
    assert.ok(!codesMatch(undefined, code));
    assert.ok(!codesMatch(['1'], code));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wrong codes lock guessing out until the window passes', async () => {
  const { AttemptLimiter } = await import('./access.js');
  const limiter = new AttemptLimiter({ max: 3, maxOverall: 5, windowMs: 1000 });
  for (let i = 0; i < 3; i++) {
    assert.ok(!limiter.blocked('a', 100));
    limiter.fail('a', 100);
  }
  assert.ok(limiter.blocked('a', 500));
  assert.ok(!limiter.blocked('b', 500), 'one device guessing does not lock out another');
  assert.ok(!limiter.blocked('a', 1200));
  // Many addresses guessing together hit the overall limit.
  for (const key of ['c', 'd', 'e', 'f', 'g']) limiter.fail(key, 2000);
  assert.ok(limiter.blocked('b', 2100));
  assert.ok(!limiter.blocked('b', 3100));
});

test('only this machine itself counts as loopback', async () => {
  const { isLoopback } = await import('./access.js');
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(isLoopback('::1'));
  assert.ok(isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('192.168.1.5'));
  assert.ok(!isLoopback(undefined));
});

test('a frame parser that saw a corrupt length ignores everything after it', async () => {
  const { FrameParser, encodeFrame } = await import('./framing.js');
  const seen = [];
  const parser = new FrameParser((type) => seen.push(type), { maxPayload: 8 });
  parser.push(encodeFrame('A', Buffer.from('ok')));
  assert.throws(() => parser.push(encodeFrame('B', Buffer.alloc(9))));
  parser.push(encodeFrame('C', Buffer.from('ok')));
  assert.deepEqual(seen, ['A']);
});
