// Media sources. Both emit the same events, so the rest of the server doesn't
// care whether the pictures come from a PS5 or from a test pattern:
//
//   'header' (Buffer)            H.264 SPS/PPS, Annex B
//   'video'  (Buffer, tsUs)      one H.264 access unit, Annex B
//   'audio'  (Buffer, tsUs?)     one Opus packet (the test pattern gives no time)
//   'event'  (object)            { type: 'connected' | 'quit' | 'rumble' | ... }
//   'log'    (string)            a line of diagnostic output
//   'exit'   ({ code, signal })  the source is gone for good

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FrameParser, encodeFrame } from './framing.js';
import { AccessUnitSplitter } from './h264.js';
import { OggOpusReader } from './ogg.js';

export const CONTROLLER_STATE_SIZE = 14;

function forwardLines(stream, emitter) {
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', (text) => {
    const lines = (tail + text).split('\n');
    tail = lines.pop();
    for (const line of lines) if (line.trim()) emitter.emit('log', line);
  });
}

// A real console, reached through the ps5-helper binary.
export class ConsoleSource extends EventEmitter {
  constructor({ helperPath, console: target, res = 1080, fps = 60, bitrate = 0, verbose = false }) {
    super();
    this.args = [
      'stream',
      '--host', target.host,
      '--res', String(res),
      '--fps', String(fps),
    ];
    // The keys go in the environment, not on the command line, where other
    // users of this machine could read them from the process list.
    this.env = { ...process.env, PS5_REGIST_KEY: target.registKey, PS5_MORNING: target.morning };
    if (bitrate > 0) this.args.push('--bitrate', String(bitrate));
    if (!target.ps5) this.args.push('--ps4');
    if (verbose) this.args.push('--verbose');
    this.helperPath = helperPath;
    this.child = null;
    this.inputPackets = 0;
    this.stopping = false;
  }

  start() {
    try {
      this.child = spawn(this.helperPath, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    } catch (err) {
      // e.g. a helper built for another kind of Mac. Report it like any
      // other failure to run, after the caller has attached its listeners.
      this.stopping = true;
      queueMicrotask(() => {
        this.emit('log', `could not run ${this.helperPath}: ${err.message}`);
        this.emit('exit', { code: null, signal: null, error: err });
      });
      return;
    }
    const parser = new FrameParser((type, payload) => this.#onFrame(type, payload));
    this.child.stdout.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (err) {
        this.emit('log', `helper output unreadable: ${err.message}`);
        this.child.kill('SIGTERM');
      }
    });
    forwardLines(this.child.stderr, this);
    this.child.stdin.on('error', () => {}); // helper exited; 'exit' reports it
    // 'error' can be followed by 'exit'; report the end once.
    let ended = false;
    const end = (info) => {
      if (ended) return;
      ended = true;
      this.stopping = true;
      this.emit('exit', info);
    };
    this.child.on('error', (err) => {
      this.emit('log', `could not run ${this.helperPath}: ${err.message}`);
      end({ code: null, signal: null, error: err });
    });
    this.child.on('exit', (code, signal) => end({ code, signal }));
  }

  #onFrame(type, payload) {
    if (type === 'E') {
      let event;
      try {
        event = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      this.emit('event', event);
      return;
    }
    if (payload.length < 8) return;
    const tsUs = Number(payload.readBigUInt64LE(0));
    // Copy, so one small frame doesn't keep a whole pipe chunk alive.
    const data = Buffer.from(payload.subarray(8));
    if (type === 'V') this.emit('video', data, tsUs);
    else if (type === 'H') this.emit('header', data);
    else if (type === 'A') this.emit('audio', data, tsUs);
  }

  #send(type, payload) {
    if (this.child?.stdin.writable) this.child.stdin.write(encodeFrame(type, payload));
  }

  sendController(state) {
    if (state.length !== CONTROLLER_STATE_SIZE) return;
    this.inputPackets++;
    this.#send('C', state);
  }

  requestKeyframe() { this.#send('I'); }
  sendPin(pin) { this.#send('P', Buffer.from(pin, 'ascii')); }

  // sleep: also put the console into rest mode.
  stop({ sleep = false } = {}) {
    if (!this.child || this.stopping || this.child.exitCode !== null) return;
    this.stopping = true;
    this.#send(sleep ? 'S' : 'Q');
    this.child.stdin.end();
    // The helper normally exits within a second; don't let it linger.
    const child = this.child;
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000).unref();
  }
}

// A test pattern with a beep, encoded live by ffmpeg the same way the PS5
// encodes its picture. Lets you try the whole browser side without a console.
export class DemoSource extends EventEmitter {
  constructor({ res = 720, fps = 60, bitrate = 6000 } = {}) {
    super();
    const height = [360, 540, 720, 1080].includes(res) ? res : 720;
    this.size = `${Math.round((height * 16) / 9)}x${height}`;
    this.fps = fps === 30 ? 30 : 60;
    this.bitrate = bitrate > 0 ? bitrate : 6000;
    this.children = [];
    this.inputPackets = 0;
    this.stopped = false;
    this.exited = false;
    this.stopping = false;
  }

  start() {
    const video = spawn('ffmpeg', [
      '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', `testsrc2=size=${this.size}:rate=${this.fps}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-bf', '0',
      '-g', String(this.fps), '-b:v', `${this.bitrate}k`,
      '-x264-params', 'aud=1:repeat-headers=1',
      '-f', 'h264', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const audio = spawn('ffmpeg', [
      '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', 'sine=frequency=220:beep_factor=4:sample_rate=48000',
      '-af', 'volume=0.2', '-ac', '2',
      '-c:a', 'libopus', '-b:a', '96k', '-frame_duration', '10',
      '-page_duration', '10000', '-flush_packets', '1',
      '-f', 'ogg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children = [video, audio];

    const start = process.hrtime.bigint();
    const splitter = new AccessUnitSplitter((unit) => {
      const tsUs = Number((process.hrtime.bigint() - start) / 1000n);
      this.emit('video', Buffer.from(unit), tsUs);
    });
    video.stdout.on('data', (chunk) => splitter.push(chunk));
    const ogg = new OggOpusReader((packet) => this.emit('audio', Buffer.from(packet)));
    audio.stdout.on('data', (chunk) => ogg.push(chunk));

    for (const child of this.children) {
      forwardLines(child.stderr, this);
      child.on('error', (err) => {
        this.emit('log', `could not run ffmpeg: ${err.message}`);
        this.#finish({ code: null, signal: null, error: err });
      });
      child.on('exit', (code, signal) => this.#finish({ code, signal }));
    }

    queueMicrotask(() => {
      this.emit('event', { type: 'audio_header', channels: 2, rate: 48000, frame_size: 480 });
      this.emit('event', { type: 'connected' });
    });
  }

  // Either ffmpeg ending ends the demo; report it once.
  #finish(info) {
    if (this.exited) return;
    this.exited = true;
    this.stopping = true;
    for (const child of this.children) if (child.exitCode === null) child.kill('SIGTERM');
    // Mirror what the console helper reports: a quit event, then exit.
    this.emit('event', this.stopped
      ? { type: 'quit', reason: 'Stopped', detail: '', error: false }
      : { type: 'quit', reason: 'ffmpeg stopped (is it installed?)', detail: '', error: true });
    this.emit('exit', info);
  }

  sendController(state) {
    if (state.length === CONTROLLER_STATE_SIZE) this.inputPackets++;
  }

  requestKeyframe() {} // the test pattern has a keyframe every second anyway
  sendPin() {}

  stop() {
    this.stopped = true;
    this.stopping = true;
    for (const child of this.children) if (child.exitCode === null) child.kill('SIGTERM');
  }
}
