// Ties one media source (the console, or the demo pattern) to one viewer (the
// browser). The console session starts when a viewer arrives and ends shortly
// after the last one leaves.

import { Viewer } from './viewer.js';
import { CONTROLLER_STATE_SIZE, ConsoleSource, DemoSource } from './source.js';
import { discover, locateConsole, wakeup } from './discovery.js';
import { keepAwake } from './awake.js';

const RESOLUTIONS = [360, 540, 720, 1080];
const IDLE_STOP_MS = 10_000;
const CONNECT_TIMEOUT_MS = 30_000;
const WAKE_TIMEOUT_MS = 75_000;
const KEYFRAME_MIN_INTERVAL_MS = 700;
// Sound arrives a hundred times a second even when the game is silent, so
// this long with neither sound nor picture means the session has died.
const STALLED_SOURCE_MS = 8000;
// How long after such a death to keep retrying while the console says it is
// still busy with the old session, and how often.
const RETRY_BUSY_MS = 60_000;
const RETRY_BUSY_GAP_MS = 4000;
const BUSY_TRIES = 3; // retries when nothing says a session of ours just died
// The console ends Remote Play when its own controller turns on: whoever is
// at the console comes first. It stays on, though, and takes Remote Play
// straight back with that controller still working. So join again, and the
// PS5's own controller plays the game being watched. Not more than a few
// times in a row, in case the console really does not want us.
const REJOIN_GAP_MS = 2500;
const REJOIN_LIMIT = 3;
const REJOIN_WINDOW_MS = 120_000;

// True when the console itself ended the session (as opposed to the network
// failing, or us stopping). It says the same when it goes into rest mode;
// whether it is still on afterwards tells the two apart.
export function consoleEndedIt(reason = '', detail = '') {
  return /server shut(ting)? down/i.test(`${reason} ${detail}`);
}

// Whether to join the console again after a session ended. The console says
// this goodbye politely (it is not reported as an error), so whether it was
// an error must not come into it: only that the console ended it, that we
// did not ask it to, and that someone is still watching.
export function shouldRejoin({ reason, detail, weStopped, watching, rejoinsLeft }) {
  return consoleEndedIt(reason, detail) && !weStopped && watching && rejoinsLeft;
}
// After joining again, how long and how often to retry if that fails.
const REJOIN_RETRY_MS = 45_000;
const REJOIN_TRIES = 4;

// Plain-language versions of the reasons chiaki reports for a session ending.
const QUIT_HINTS = [
  [/already in use/i, 'Another device is already using Remote Play on this PS5. Close it there and try again.'],
  [/version mismatch/i, 'The PS5 system software is newer than this bridge understands. Raise CHIAKI_TAG in scripts/setup.sh to the newest chiaki-ng release and run: npm run setup'],
  [/connection refused/i, 'The PS5 refused the connection. Check that Remote Play is enabled (Settings > System > Remote Play), then link again with: npm run link'],
  [/failed to connect|unknown session request/i, 'Could not reach the PS5. Make sure it is on, or in rest mode with "Stay Connected to the Internet" enabled, and on the same network as this Mac.'],
  [/server shut down/i, 'The PS5 was turned off or put into rest mode.'],
  [/disconnected/i, 'The PS5 closed the connection.'],
];

export function describeQuit(reason, detail) {
  for (const [pattern, hint] of QUIT_HINTS) if (pattern.test(reason)) return hint;
  return detail ? `${reason} (${detail})` : reason;
}

// Clamps whatever the browser asked for to something the console accepts.
export function normalizeOptions(raw = {}) {
  const res = RESOLUTIONS.includes(Number(raw.res)) ? Number(raw.res) : 1080;
  const fps = Number(raw.fps) === 30 ? 30 : 60;
  const bitrate = Number.isFinite(Number(raw.bitrate)) ? Math.max(0, Math.min(50_000, Math.round(Number(raw.bitrate)))) : 0;
  return { res, fps, bitrate };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Bridge {
  // `reach` replaces how the console is found and connected to; tests use it.
  constructor({ demo = false, console: target = null, helperPath, verbose = false, log = () => {}, onConsoleMoved = () => {}, reach = {} }) {
    this.reach = { locate: locateConsole, discover, createSource: null, ...reach };
    this.rejoinTries = 0;
    this.demo = demo;
    this.console = target;
    this.onConsoleMoved = onConsoleMoved;
    this.helperPath = helperPath;
    this.verbose = verbose;
    this.log = log;

    this.viewer = null;
    this.nextViewerId = 1;
    this.source = null;
    this.sourceOptions = null;
    this.sourceConnected = false;
    this.sourceQuitReported = false;
    this.header = null;
    this.audioFrameSize = 480;
    this.framesLost = 0;
    this.startToken = 0;
    this.idleTimer = null;
    this.lastKeyframeRequest = 0;
    this.busyTries = 0;

    // A slip in the once-a-second housekeeping must never end the game.
    this.statsTimer = setInterval(() => {
      try {
        this.#sendStats();
      } catch (err) {
        this.log(`unexpected error: ${err.stack ?? err.message}`);
      }
    }, 1000);
    this.statsTimer.unref();
  }

  status() {
    return {
      mode: this.demo ? 'demo' : 'console',
      linked: this.demo || Boolean(this.console),
      name: this.demo ? 'Test pattern' : this.console?.name ?? '',
      streaming: Boolean(this.source) && this.sourceConnected,
      watching: Boolean(this.viewer),
    };
  }

  // A browser wants to watch. Returns the WebRTC offer for it to answer.
  async connect(rawOptions) {
    if (!this.demo && !this.console) throw Object.assign(new Error('No PS5 is linked yet. Run: npm run link'), { status: 409 });
    const options = normalizeOptions(rawOptions);

    if (this.viewer) {
      this.viewer.sendControl({ type: 'replaced' });
      this.viewer.close();
    }
    const viewer = new Viewer({ id: this.nextViewerId++ });
    this.viewer = viewer;
    viewer.on('open', () => {
      this.#attach(viewer, options).catch((err) => {
        this.log(`could not start the stream: ${err.stack ?? err.message}`);
        viewer.sendControl({ type: 'ended', error: true, message: 'The bridge could not start the stream. Its window on the Mac has the details.' });
      });
    });
    viewer.on('input', (state) => this.source?.sendController(state));
    viewer.on('control', (message) => this.#onControl(viewer, message));
    viewer.on('closed', () => this.#detach(viewer));
    // No input can arrive during a hiccup: don't leave a button or stick held.
    viewer.on('stalled', () => this.source?.sendController(Buffer.alloc(CONTROLLER_STATE_SIZE)));
    viewer.on('recovered', () => {
      if (this.viewer === viewer && this.sourceConnected) this.#requestKeyframe(true);
    });
    viewer.on('state', (state) => this.log(`viewer ${viewer.id}: ${state}`));
    // A browser that asked to connect and then went away (headset taken off,
    // page closed) never answers; don't keep a console session up for it.
    setTimeout(() => {
      if (!viewer.ready && !viewer.closed) {
        this.log(`viewer ${viewer.id}: never finished connecting`);
        viewer.close();
      }
    }, CONNECT_TIMEOUT_MS).unref();

    const sdp = await viewer.createOffer();
    return { id: viewer.id, sdp };
  }

  answer(id, sdp) {
    if (!this.viewer || this.viewer.id !== id) throw Object.assign(new Error('That connection attempt is no longer current.'), { status: 409 });
    this.viewer.acceptAnswer(sdp);
  }

  shutdown() {
    this.letSleep?.();
    clearInterval(this.statsTimer);
    clearTimeout(this.idleTimer);
    this.viewer?.close();
    this.source?.stop();
  }

  // ---------------------------------------------------------------- viewer

  async #attach(viewer, options) {
    clearTimeout(this.idleTimer);
    const sameSettings = this.sourceOptions
      && this.sourceOptions.res === options.res
      && this.sourceOptions.fps === options.fps
      && this.sourceOptions.bitrate === options.bitrate;

    // A source that is on its way out can't be picked up; wait for it to go
    // and start a fresh one.
    if (this.source && sameSettings && !this.source.stopping) {
      // Picking up a session that is already running (e.g. a page reload).
      if (this.header) viewer.setHeader(this.header);
      viewer.setAudioFrameSize(this.audioFrameSize);
      viewer.sendControl({ type: 'state', state: this.sourceConnected ? 'streaming' : 'connecting' });
      if (this.sourceConnected) this.#requestKeyframe(true);
      return;
    }
    if (this.source) await this.#stopSource();
    if (this.viewer !== viewer) return;
    await this.#startSource(viewer, options);
  }

  #detach(viewer) {
    if (this.viewer !== viewer) return;
    this.viewer = null;
    this.startToken++; // abandon any wake-up still in progress
    clearTimeout(this.idleTimer);
    // Let go of every button and stick: whatever was held when the browser
    // went away would otherwise stay held in the game.
    this.source?.sendController(Buffer.alloc(CONTROLLER_STATE_SIZE));
    // Leave the console session up briefly so a reload doesn't drop the game.
    this.idleTimer = setTimeout(() => {
      if (!this.viewer && this.source) {
        this.log('no viewer; ending console session');
        this.source.stop();
      }
    }, IDLE_STOP_MS);
  }

  #onControl(viewer, message) {
    if (this.viewer !== viewer) return;
    switch (message.type) {
      case 'keyframe':
        viewer.resync();
        this.#requestKeyframe(false);
        break;
      case 'pin':
        if (typeof message.pin === 'string' && /^\d{4,8}$/.test(message.pin)) this.source?.sendPin(message.pin);
        break;
      case 'stop':
        this.source?.stop({ sleep: message.sleep === true });
        break;
      case 'diag': {
        // What the browser says about controllers, logged whenever it changes,
        // so input problems can be diagnosed from the Mac.
        // The text comes from the browser: keep it short and printable.
        const line = (`browser: secure=${Boolean(message.secure)} gamepadApi=${Boolean(message.api)} `
          + `touch=${Boolean(message.touch)} fullscreen=${Boolean(message.fullscreen)} focused=${Boolean(message.focused)} `
          + `app=${Boolean(message.app)} touchPoints=${Number(message.touchPoints) || 0} ua="${String(message.ua ?? '').slice(0, 140)}" pads=${JSON.stringify(message.pads ?? []).slice(0, 300)} pressed=${Number(message.pressed) || 0}`)
          .replace(/[^\x20-\x7e]/g, '?');
        if (line !== this.lastDiag) {
          this.lastDiag = line;
          this.log(line);
        }
        break;
      }
      default:
        break;
    }
  }

  #requestKeyframe(force) {
    const now = Date.now();
    if (!force && now - this.lastKeyframeRequest < KEYFRAME_MIN_INTERVAL_MS) return;
    this.lastKeyframeRequest = now;
    this.source?.requestKeyframe();
  }

  #sendStats() {
    const viewer = this.viewer;
    this.#checkSource(); // may let go of a session that has died
    if (!viewer?.ready || !this.source) {
      this.lastStatsAt = null; // don't average the next sample over the gap
      return;
    }
    const { videoBytes, videoFrames } = viewer.takeStats();
    const inputPackets = this.source.inputPackets;
    this.source.inputPackets = 0;
    // Timers run late on a busy machine, so divide by the time that really passed.
    const now = Date.now();
    const seconds = Math.max(0.001, (now - (this.lastStatsAt ?? now - 1000)) / 1000);
    this.lastStatsAt = now;
    // Log controller traffic when it starts and stops, to confirm presses arrive.
    const receiving = inputPackets > 0;
    if (receiving !== Boolean(this.inputWasArriving)) {
      this.inputWasArriving = receiving;
      this.log(receiving ? `controller input arriving (${inputPackets} updates in the last second), passing it to the PS5` : 'controller input stopped');
    }
    viewer.sendControl({
      type: 'stats',
      kbps: Math.round((videoBytes * 8) / 1000 / seconds),
      fps: Math.round(videoFrames / seconds),
      inputHz: Math.round(inputPackets / seconds),
      framesLost: this.framesLost,
    });
  }

  // ---------------------------------------------------------------- source

  async #startSource(viewer, options) {
    const token = ++this.startToken;
    const current = () => token === this.startToken && this.viewer === viewer;

    if (!this.demo) {
      viewer.sendControl({ type: 'state', state: 'searching' });
      const ready = await this.#ensureAwake(viewer, current);
      if (!current()) return;
      if (!ready) {
        viewer.sendControl({
          type: 'ended',
          error: true,
          message: 'The PS5 did not wake up. Turn it on, or enable "Enable Turning On PS5 from Network" in Settings > System > Power Saving > Features Available in Rest Mode.',
        });
        return;
      }
    }

    viewer.sendControl({ type: 'state', state: 'connecting' });
    const source = this.reach.createSource?.(options) ?? (this.demo
      ? new DemoSource(options)
      : new ConsoleSource({ helperPath: this.helperPath, console: this.console, verbose: this.verbose, ...options }));
    this.source = source;
    this.sourceOptions = options;
    this.sourceConnected = false;
    this.sourceQuitReported = false;
    this.header = null;
    this.framesLost = 0;

    source.on('log', (line) => this.log(`  ${line}`));
    source.on('header', (header) => {
      this.header = header;
      // New parameter sets mean a new picture format: restart on a keyframe.
      this.viewer?.setHeader(header);
      this.viewer?.resync();
    });
    source.on('video', (unit, tsUs) => {
      this.lastMediaAt = Date.now();
      const v = this.viewer;
      if (v && !v.pushVideo(unit, tsUs) && v.ready && v.needKeyframe) this.#requestKeyframe(false);
    });
    source.on('audio', (packet, tsUs) => {
      this.lastMediaAt = Date.now();
      this.viewer?.pushAudio(packet, tsUs);
    });
    source.on('event', (event) => this.#onSourceEvent(source, event));
    source.on('exit', ({ code, signal }) => {
      if (this.source !== source) return;
      this.source = null;
      this.sourceOptions = null;
      this.sourceConnected = false;
      this.letSleep?.();
      this.letSleep = null;
      this.log(`source ended (code ${code}, signal ${signal})`);
      if (!this.sourceQuitReported) {
        this.viewer?.sendControl({
          type: 'ended',
          error: true,
          message: code === null && !signal
            ? 'The PS5 helper is missing. Run: npm run setup'
            : `The PS5 helper stopped unexpectedly (code ${code ?? signal}).`,
        });
      }
    });
    this.log(this.demo ? 'starting test pattern' : `connecting to ${this.console.name} at ${this.console.host}`);
    this.letSleep?.();
    this.letSleep = keepAwake(); // until this session ends
    source.start();
  }

  #onSourceEvent(source, event) {
    if (this.source !== source) return;
    switch (event.type) {
      case 'connected':
        this.sourceConnected = true;
        this.busyTries = 0;
        this.rejoinUntil = 0;
        this.lastMediaAt = Date.now();
        this.log('stream connected');
        this.viewer?.sendControl({ type: 'state', state: 'streaming' });
        break;
      case 'audio_header':
        this.audioFrameSize = event.frame_size || 480;
        this.viewer?.setAudioFrameSize(this.audioFrameSize);
        break;
      case 'frames_lost':
        this.framesLost += event.count || 0;
        break;
      case 'video_skipped':
        // The helper left pictures out because we were behind (a busy Mac,
        // or a viewer on a weak connection). The picture restarts from a
        // keyframe; ask the console for one.
        this.viewer?.resync();
        this.#requestKeyframe(true);
        break;
      case 'login_pin_request':
        this.viewer?.sendControl({ type: 'pin_request', incorrect: Boolean(event.incorrect) });
        break;
      case 'rumble':
        this.viewer?.sendControl({ type: 'rumble', left: event.left, right: event.right });
        break;
      case 'quit':
        this.sourceQuitReported = true;
        this.log(`session ended: ${event.reason}${event.detail ? ` (${event.detail})` : ''}`);
        // After a session died without a goodbye, the console goes on
        // holding it for a little while and turns the new one away.
        // The same happens after the bridge itself was closed mid-game and
        // started again, so a few tries are always worth it before saying
        // that someone else is playing.
        if (event.error && /already in use/i.test(event.reason) && this.viewer
          && (Date.now() < (this.retryBusyUntil ?? 0) || this.busyTries < BUSY_TRIES)) {
          this.busyTries++;
          this.#retrySoon(source);
          break;
        }
        if (shouldRejoin({
          reason: event.reason,
          detail: event.detail,
          weStopped: source.stopping,
          watching: Boolean(this.viewer),
          rejoinsLeft: this.#mayRejoin(),
        })) {
          this.#rejoin(source, describeQuit(event.reason, event.detail));
          break;
        }
        // The first try at joining again can come too soon for the console.
        if (event.error && this.viewer && !source.stopping && Date.now() < (this.rejoinUntil ?? 0)
          && this.rejoinTries < REJOIN_TRIES) {
          this.rejoinTries++;
          this.#retrySoon(source);
          break;
        }
        this.viewer?.sendControl({
          type: 'ended',
          error: Boolean(event.error),
          message: event.error ? describeQuit(event.reason, event.detail) : 'Session ended.',
        });
        break;
      default:
        break;
    }
  }

  #stopSource() {
    const source = this.source;
    if (!source) return Promise.resolve();
    return new Promise((resolve) => {
      source.once('exit', resolve);
      source.stop();
    });
  }

  // Starts the session again a few seconds after `source` has gone, for
  // whoever is still watching.
  #retrySoon(source) {
    const viewer = this.viewer;
    const options = this.sourceOptions;
    this.log('the console is not taking the session yet; trying again shortly');
    source.once('exit', () => {
      setTimeout(() => {
        if (!viewer || this.viewer !== viewer || this.source) return;
        this.#startSource(viewer, options)
          .catch((err) => this.log(`could not reconnect to the console: ${err.stack ?? err.message}`));
      }, RETRY_BUSY_GAP_MS);
    });
  }

  #mayRejoin() {
    const now = Date.now();
    this.rejoins = (this.rejoins ?? []).filter((at) => now - at < REJOIN_WINDOW_MS);
    return this.rejoins.length < REJOIN_LIMIT;
  }

  // The console ended the session but may still be on (see REJOIN_GAP_MS).
  // If it is, start a new session for whoever is watching; if it has gone to
  // sleep, pass on `goodbye` after all.
  #rejoin(source, goodbye) {
    const viewer = this.viewer;
    const options = this.sourceOptions;
    this.rejoins.push(Date.now());
    viewer.sendControl({ type: 'state', state: 'rejoining' });
    source.once('exit', () => {
      setTimeout(async () => {
        try {
          if (this.viewer !== viewer || this.source) return;
          const found = (await this.reach.discover({ host: this.console.host, timeoutMs: 1500 }))[0];
          if (this.viewer !== viewer || this.source) return;
          if (found?.state !== 'ready') {
            this.log('the console has gone to sleep or is off');
            viewer.sendControl({ type: 'ended', error: false, message: goodbye });
            return;
          }
          this.log('the console is still on (its own controller probably turned on); joining it again');
          this.retryBusyUntil = Date.now() + RETRY_BUSY_MS;
          this.rejoinUntil = Date.now() + REJOIN_RETRY_MS;
          this.rejoinTries = 0;
          await this.#startSource(viewer, options);
        } catch (err) {
          this.log(`could not rejoin the console: ${err.stack ?? err.message}`);
          viewer.sendControl({ type: 'ended', error: true, message: goodbye });
        }
      }, REJOIN_GAP_MS);
    });
  }

  // A session can die without saying so: the link to the console drops and
  // the helper keeps waiting on it for ever, with the picture frozen. Notice,
  // and connect to the console again for whoever is watching.
  #checkSource() {
    const source = this.source;
    if (!source || !this.sourceConnected || source.stopping) return;
    if (Date.now() - this.lastMediaAt < STALLED_SOURCE_MS) return;
    const viewer = this.viewer;
    const options = this.sourceOptions;
    this.log('nothing from the console for a while; connecting to it again');
    this.retryBusyUntil = Date.now() + RETRY_BUSY_MS;
    viewer?.sendControl({ type: 'state', state: 'connecting' });
    // Let go of the dead session first, so its goodbye isn't passed on to the
    // browser as the end of the game.
    this.source = null;
    this.sourceOptions = null;
    this.sourceConnected = false;
    const gone = new Promise((resolve) => {
      source.once('exit', resolve);
      setTimeout(resolve, 6000).unref(); // it is killed after 5 s if it won't go
    });
    source.stop();
    gone.then(() => {
      if (!viewer || this.viewer !== viewer || this.source) {
        this.letSleep?.();
        this.letSleep = null;
        return null;
      }
      return this.#startSource(viewer, options);
    }).catch((err) => this.log(`could not reconnect to the console: ${err.stack ?? err.message}`));
  }

  // Finds the console and, if it is in rest mode, wakes it and waits.
  // Returns true once it should accept a connection.
  async #ensureAwake(viewer, current) {
    const located = await this.reach.locate(this.console);
    if (!current()) return false;
    if (located.moved) this.#consoleMoved(located.reply);
    if (located.otherDevice) this.log(`the device at ${this.console.host} is not ${this.console.name}`);
    const host = this.console.host;
    let found = located.reply;
    if (found?.state === 'ready') return true;
    if (!found) {
      // No reply at all. macOS may be blocking local-network access, or the
      // console is unplugged; a direct connection attempt gives a clearer answer.
      this.log(`no discovery reply from ${host}; trying to connect anyway`);
      return true;
    }

    this.log(`${this.console.name} is in rest mode; waking it`);
    viewer.sendControl({ type: 'state', state: 'waking' });
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await wakeup(host, this.console.registKey, { ps5: this.console.ps5 }).catch((err) => this.log(`wake-up failed: ${err.message}`));
      await sleep(2000);
      if (!current()) return false;
      found = (await this.reach.discover({ host, timeoutMs: 1000 }))[0];
      if (!current()) return false;
      if (found?.state === 'ready') {
        // The console answers discovery a little before Remote Play is up.
        await sleep(3000);
        return current();
      }
    }
    return false;
  }

  #consoleMoved(reply) {
    this.log(`${this.console.name} moved from ${this.console.host} to ${reply.address}`);
    this.console = {
      ...this.console,
      host: reply.address,
      mac: this.console.mac || reply.id.replace(/[^0-9a-f]/gi, '').toLowerCase(),
    };
    try {
      this.onConsoleMoved(this.console);
    } catch (err) {
      this.log(`could not save the new address: ${err.message}`);
    }
  }
}
