// The page the headset opens. It receives the console's video and audio over
// WebRTC and sends controller input back.

import { BUTTON, encodeState, idleState, readGamepad, statesEqual } from './controller.js';
import { KEY_GUIDE, isMappedKey, keyboardState, mergeStates } from './keyboard.js';

const $ = (id) => document.getElementById(id);
const video = $('screen');
const hud = $('hud');
const overlay = $('overlay');
const panels = ['panel-start', 'panel-progress', 'panel-pin', 'panel-ended', 'panel-tap'].map($);

const PROGRESS_TEXT = {
  searching: 'Looking for your PS5…',
  waking: 'Waking your PS5… this can take up to a minute.',
  connecting: 'Connecting…',
};
const POLL_INTERVAL_MS = 8;      // how often the controller is read
const RESEND_INTERVAL_MS = 33;   // unchanged state is repeated, since input packets may be dropped
const HUD_HIDE_MS = 5000;
const TAP_BUTTON_MS = 150;
const API_TIMEOUT_MS = 10_000;
const STATUS_RETRY_MS = 3000;
const QUIET_REFRESH_PATIENCE_MS = 3000;

let pc = null;
let inputChannel = null;
let controlChannel = null;
let streaming = false;
let statusCache = null;
let statusRetryTimer = null;
let virtualButtons = 0;
let lastSent = idleState();
let lastSentAt = 0;
let pollTimer = null;
let statsTimer = null;
let hudTimer = null;
let serverStats = null;
let previousVideoStats = null;
let stalledSamples = 0;
let frozenSamples = 0;
let lastAutoRefresh = 0;
let toastTimer = null;
// Sound goes through Web Audio so the volume slider works: Safari on Apple
// devices ignores volume changes on a video element.
let audioCtx = null;
let gainNode = null;
let audioSource = null;
// Other ways to press buttons than a controller: keys held down, buttons held
// on the on-screen controller, and a controller read by the Vision Pro app.
const heldKeys = new Set();
let padState = idleState();
let keyboardUsed = false;
let nativeState = null;
let nativeStateAt = 0;
const NATIVE_INPUT_STALE_MS = 500;
// A click or key tap can be over in a few milliseconds, between two reads of
// the input. Each press counts for at least this long, so none are lost.
const MIN_PRESS_MS = 60;
const pressedAt = new Map(); // key code or pad button -> when it went down

// Opened by the Vision Pro app (?app=1): it reads the controller itself, and
// pinching Connect over the PS5 already said "play".
const IN_APP = new URLSearchParams(location.search).has('app');
const nativeBridge = () => window.webkit?.messageHandlers?.ps5;
let autoPlayed = false;
if (IN_APP) document.documentElement.classList.add('in-app');

const AUTO_REFRESH_AFTER_S = 4;          // seconds without a new frame
const AUTO_REFRESH_MIN_GAP_MS = 15_000;  // don't loop if the network is down
const RECONNECT_TRIES = 5;               // before a reconnect gives up
const RECONNECT_GAP_MS = 2000;
const STRUGGLING_AFTER_S = 10;           // of a poor picture, before suggesting a lighter one
let starvedSamples = 0;
let poorSamples = 0;
let strugglingHinted = false;
let recentFps = [];

// ------------------------------------------------------------------ panels

function showPanel(id) {
  for (const panel of panels) panel.hidden = panel.id !== id;
  overlay.hidden = id === null;
}

function showProgress(text) {
  $('progress-text').textContent = text;
  showPanel('panel-progress');
}

function showEnded(message, isError) {
  $('ended-title').textContent = isError ? 'Could not play' : 'Session ended';
  // The title already says a plain ending; only add what it doesn't.
  const text = !isError && /^session ended\.?$/i.test(message) ? '' : message;
  $('ended-text').textContent = text;
  $('ended-text').hidden = !text;
  showPanel('panel-ended');
}

function showHud() {
  if (!streaming) return;
  hud.hidden = false;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(hideHudWhenIdle, HUD_HIDE_MS);
}

// Never pull the controls out from under someone who is using them from
// the keyboard.
function hideHudWhenIdle() {
  if (hud.contains(document.activeElement)) {
    hudTimer = setTimeout(hideHudWhenIdle, HUD_HIDE_MS);
    return;
  }
  hud.hidden = true;
  setOpen('menu', false);
  setOpen('details', false);
}

// The two things that drop down from the bar: "More" and connection details.
const DROPDOWNS = { menu: 'btn-menu', details: 'btn-status' };
function setOpen(id, open) {
  $(id).hidden = !open;
  $(DROPDOWNS[id]).setAttribute('aria-expanded', String(open));
}
function toggleDropdown(id) {
  const open = $(id).hidden;
  for (const other of Object.keys(DROPDOWNS)) setOpen(other, other === id && open);
}

// ------------------------------------------------------------------ status

// The code the bridge prints on the Mac; asked for once and remembered.
let accessCode = '';
try {
  accessCode = localStorage.getItem('access-code') ?? '';
} catch {
  // storage unavailable; the code is asked for again next visit
}

async function api(path, body) {
  // Give up on a bridge that doesn't answer rather than waiting on the
  // network's own (very long) timeout.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), API_TIMEOUT_MS);
  const headers = {};
  if (accessCode) headers['x-access-code'] = accessCode;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
  } catch {
    throw new Error('The bridge on the Mac is not answering. Check that it is running and on the same network.');
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `The bridge answered ${response.status}.`), {
      status: response.status,
      needsCode: Boolean(data.needsCode),
    });
  }
  return data;
}

function gamepadsAvailable() {
  return typeof navigator.getGamepads === 'function';
}

async function loadStatus() {
  const note = $('start-note');
  const play = $('btn-play');
  clearTimeout(statusRetryTimer);
  try {
    statusCache = await api('/api/status');
  } catch (err) {
    note.textContent = err.status ? err.message : 'The bridge on your Mac is not answering. Is it still running?';
    play.disabled = true;
    // Keep looking: the bridge may just not have been started yet.
    statusRetryTimer = setTimeout(() => {
      if (!$('panel-start').hidden) loadStatus();
    }, STATUS_RETRY_MS);
    return;
  }
  const status = statusCache;
  $('code-row').hidden = !status.needsCode;
  $('options').hidden = Boolean(status.needsCode);
  if (status.needsCode) {
    note.textContent = status.wrongCode
      ? 'That access code is not right. It is the 6-digit number the bridge shows on the Mac.'
      : 'Enter the 6-digit access code the bridge shows on the Mac. You are only asked once on this device.';
    play.disabled = true;
    return;
  }
  $('mode-badge').hidden = status.mode !== 'demo';
  $('console-name').textContent = status.name || 'PS5';
  if (!status.linked) {
    note.textContent = 'No PS5 is linked yet. On the Mac, run: npm run link';
    play.disabled = true;
  } else if (status.mode === 'console' && !status.helperBuilt) {
    note.textContent = 'The PS5 helper is not built yet. On the Mac, run: npm run setup';
    play.disabled = true;
  } else {
    note.textContent = status.mode === 'demo'
      ? 'Plays a test pattern with a beep, to check picture, sound and controller without a console.'
      : status.streaming ? 'A session is already running. Play to pick it up.' : 'Ready.';
    play.disabled = false;
    if (IN_APP && !autoPlayed && !$('panel-start').hidden) {
      autoPlayed = true;
      play.click(); // `play` here is the Play button, not the function
    }
  }

  updatePadNote();
}

function updatePadNote() {
  const status = statusCache ?? {};
  const padNote = $('pad-note');
  if (gamepadsAvailable()) {
    padNote.textContent = 'Controller: pair it with this device over Bluetooth, not with the PS5 (the PS5 ends Remote Play when its own controller turns on). No controller? The keyboard works too (press ? while playing), and More > On-screen buttons shows one you can click.';
  } else if (status.secureUrl) {
    padNote.innerHTML = '';
    padNote.append('This browser only allows controllers on a secure page. Open ');
    const link = document.createElement('a');
    link.href = status.secureUrl;
    link.textContent = status.secureUrl;
    padNote.append(link, ' instead. The keyboard and the on-screen buttons work on this page too.');
  } else {
    padNote.textContent = 'This browser does not share game controllers with pages. Play with the keyboard (press ? while playing) or the on-screen buttons.';
  }
}

// --------------------------------------------------------------- streaming

// Show frames as soon as they arrive rather than buffering for smoothness.
function preferLowDelay(receiver) {
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
    if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
  } catch {
    // Optional tuning; the server asks for the same thing in the stream itself.
  }
}

async function startPlayback() {
  try {
    await video.play();
    if (!$('panel-tap').hidden) showPanel(streaming ? null : 'panel-progress');
  } catch {
    // The browser wants a tap before it will play with sound.
    showPanel('panel-tap');
  }
}

// Fills the whole screen. Browsers only allow this straight from a click,
// so it is called first thing in the Play handler, before anything awaits.
function enterFullscreen() {
  const stage = $('stage');
  if (document.fullscreenElement || document.webkitFullscreenElement) return;
  try {
    if (stage.requestFullscreen) stage.requestFullscreen().then(keepEscapeForTheGame).catch(() => {});
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
  } catch {
    // Not allowed here; the Fullscreen button still works.
  }
}

// Esc is the circle button, but in fullscreen the browser takes it to leave
// fullscreen. Where the browser can hand it over (Chrome and Edge), a tap of
// Esc reaches the game and holding it leaves fullscreen.
function keepEscapeForTheGame() {
  navigator.keyboard?.lock?.(['Escape']).catch(() => {});
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
  else if ($('stage').requestFullscreen || $('stage').webkitRequestFullscreen) enterFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
}

// ------------------------------------------------------------------ volume

function savedNumber(key, fallback) {
  try {
    const value = Number(localStorage.getItem(key));
    return localStorage.getItem(key) !== null && Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

let muted = savedNumber('muted', 0) === 1;
$('volume').value = String(savedNumber('volume', 80));

// Must run from a tap: browsers only start sound after the user asks for it.
function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext({ latencyHint: 'interactive' });
      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
    } catch {
      audioCtx = null; // fall back to the video element's own sound
    }
  }
  audioCtx?.resume().catch(() => {});
  applyVolume();
}

function routeAudio(track) {
  if (!audioCtx) return;
  try {
    audioSource?.disconnect();
    audioSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
    audioSource.connect(gainNode);
    video.muted = true; // Web Audio plays it now; avoid hearing it twice
  } catch {
    audioSource = null;
    video.muted = false;
  }
}

function applyVolume() {
  const level = Number($('volume').value) / 100;
  // Squared, because loudness is heard on a curve: the slider then feels even.
  const gain = muted ? 0 : level * level;
  if (gainNode) gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, 0.02);
  if (!audioSource) {
    video.muted = muted;
    video.volume = level;
  }
  $('btn-mute').dataset.state = muted || level === 0 ? 'off' : level < 0.5 ? 'low' : 'on';
  $('btn-mute').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  try {
    localStorage.setItem('volume', $('volume').value);
    localStorage.setItem('muted', muted ? '1' : '0');
  } catch {
    // storage unavailable; the setting just won't be remembered
  }
}

function showToast(text, ms = 2500) {
  const toast = $('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
}

// Reconnects the picture and sound to the Mac. The Mac keeps its link to the
// PS5 running, so this takes a second or two and the game is never interrupted.
function refresh({ auto = false } = {}) {
  if (auto) lastAutoRefresh = Date.now();
  showToast(auto ? 'Picture froze, refreshing…' : 'Refreshing…');
  play({ quiet: true });
}

let playGeneration = 0;

async function play({ quiet = false, attempt = 1 } = {}) {
  // Each call supersedes any attempt still connecting, so a refresh tapped
  // while another is in flight can't leave two connections fighting.
  teardown(); // also cancels any attempt still in flight
  const generation = playGeneration;
  const current = () => generation === playGeneration;
  ensureAudio();
  if (!quiet) {
    enterFullscreen();
    showProgress(PROGRESS_TEXT.connecting);
  } else {
    // A refresh normally shows the picture again within a second or two. If
    // it doesn't, say so and offer Cancel instead of leaving a black screen.
    setTimeout(() => {
      if (current() && !streaming && overlay.hidden) showProgress('Reconnecting…');
    }, QUIET_REFRESH_PATIENCE_MS);
  }
  // Sound will play through Web Audio, so the video element stays silent;
  // a silent video is also allowed to start without another tap.
  if (audioCtx) video.muted = true;
  // Calling play() during the tap unlocks playback for when the stream arrives.
  video.srcObject = new MediaStream();
  video.play().catch(() => {});

  const res = Number($('opt-res').value);
  const options = { res, fps: Number($('opt-fps').value) };
  // A lighter stream means fewer packets per frame, so a Wi-Fi hiccup is less
  // likely to break a frame (and freeze the picture until the next keyframe).
  // The console's own defaults are 15 Mbps at 1080p and 10 Mbps at 720p.
  if ($('opt-net').value === 'weak') options.bitrate = { 1080: 8000, 720: 5000, 540: 3000 }[res] ?? 0;
  let offer;
  try {
    offer = await api('/api/connect', options);
  } catch (err) {
    if (!current()) return;
    if (err.needsCode) {
      // The code was changed on the Mac; ask for the new one.
      showPanel('panel-start');
      loadStatus();
    } else if (quiet && !err.status && attempt < RECONNECT_TRIES) {
      // A reconnect that got no answer: the Mac is busy or the Wi-Fi is still
      // out. The game is still running there, so keep trying for a while
      // rather than giving up on it.
      showProgress('Reconnecting…');
      setTimeout(() => { if (current()) play({ quiet: true, attempt: attempt + 1 }); }, RECONNECT_GAP_MS);
    } else {
      showEnded(err.message, true);
    }
    return;
  }
  if (!current()) return;

  const connection = new RTCPeerConnection();
  pc = connection;
  connection.addEventListener('track', (event) => {
    preferLowDelay(event.receiver);
    if (event.track.kind === 'audio') routeAudio(event.track);
    if (event.streams[0] && video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
      startPlayback();
    }
  });
  connection.addEventListener('datachannel', (event) => {
    const channel = event.channel;
    if (channel.label === 'input') {
      channel.binaryType = 'arraybuffer';
      inputChannel = channel;
    } else if (channel.label === 'control') {
      controlChannel = channel;
      channel.addEventListener('message', (message) => onControl(connection, message.data));
    }
  });
  const lost = () => {
    if (pc !== connection) return;
    // A Wi-Fi blip: reconnect by itself (at most every 15 s) before giving up.
    if (streaming && Date.now() - lastAutoRefresh > AUTO_REFRESH_MIN_GAP_MS) {
      refresh({ auto: true });
      return;
    }
    teardown();
    showEnded('Lost the connection to the Mac. Check that both are on the same Wi-Fi.', true);
  };
  connection.addEventListener('connectionstatechange', () => {
    if (pc !== connection) return;
    if (connection.connectionState === 'failed') lost();
    // "disconnected" often heals itself within a few seconds, and the Mac
    // waits a little longer than this before letting go of its end.
    else if (connection.connectionState === 'disconnected') {
      setTimeout(() => {
        if (['disconnected', 'failed'].includes(connection.connectionState)) lost();
      }, 4000);
    }
  });

  try {
    await connection.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    await connection.setLocalDescription(await connection.createAnswer());
    if (pc !== connection) return;
    // Reply straight away, without waiting to list this device's own network
    // addresses: the Mac's address is in its offer, so this side makes the
    // first contact and the Mac learns where we are from that.
    await api('/api/answer', { id: offer.id, sdp: connection.localDescription.sdp });
  } catch (err) {
    if (pc !== connection || !current()) return;
    teardown();
    showEnded(err.message, true);
    return;
  }
  if (pc !== connection || !current()) return;

  pollTimer = setInterval(pollController, POLL_INTERVAL_MS);
  statsTimer = setInterval(() => sampleStats(connection), 1000);
}

function onControl(connection, raw) {
  if (pc !== connection || typeof raw !== 'string') return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  switch (message.type) {
    case 'state':
      if (message.state === 'streaming') {
        streaming = true;
        $('stage').classList.add('playing');
        showPanel($('panel-tap').hidden ? null : 'panel-tap');
        updatePad();
        showHud();
        hintAboutInput();
      } else if (PROGRESS_TEXT[message.state]) {
        showProgress(PROGRESS_TEXT[message.state]);
      }
      break;
    case 'pin_request':
      $('pin-note').textContent = message.incorrect
        ? 'That passcode was not accepted. Try again.'
        : 'Enter the passcode for your PS5 user.';
      $('pin-input').value = '';
      showPanel('panel-pin');
      $('pin-input').focus();
      break;
    case 'stats':
      serverStats = message;
      break;
    case 'rumble':
      rumble(message.left, message.right);
      break;
    case 'replaced':
      teardown();
      showEnded('The stream was opened somewhere else.', false);
      break;
    case 'ended':
      teardown();
      showEnded(message.message || 'Session ended.', Boolean(message.error));
      break;
    default:
      break;
  }
}

function sendControl(message) {
  if (controlChannel?.readyState === 'open') controlChannel.send(JSON.stringify(message));
}

function teardown() {
  playGeneration++; // anything still connecting is no longer wanted
  clearInterval(pollTimer);
  clearInterval(statsTimer);
  clearTimeout(hudTimer);
  pollTimer = statsTimer = null;
  streaming = false;
  $('stage').classList.remove('playing');
  hud.hidden = true;
  inputChannel = controlChannel = null;
  serverStats = previousVideoStats = null;
  stalledSamples = 0;
  frozenSamples = 0;
  starvedSamples = 0;
  poorSamples = 0;
  recentFps = [];
  $('signal').dataset.level = '0';
  setOpen('menu', false);
  setOpen('details', false);
  virtualButtons = 0;
  releaseAllInput();
  updatePad();
  lastSent = idleState();
  $('stats').textContent = '';
  if (pc) {
    const old = pc;
    pc = null;
    old.close();
  }
  video.srcObject = null;
}

// -------------------------------------------------------------- controller

// The controller to read: one the browser has mapped to the standard layout
// if there is one, and among equals the one touched most recently. Other
// devices sometimes show up as "gamepads" too and must not shadow the real one.
function activeGamepad() {
  if (!gamepadsAvailable()) return null;
  let best = null;
  for (const gamepad of navigator.getGamepads()) {
    if (!gamepad?.connected) continue;
    const better = !best
      || (gamepad.mapping === 'standard') > (best.mapping === 'standard')
      || ((gamepad.mapping === 'standard') === (best.mapping === 'standard') && gamepad.timestamp > best.timestamp);
    if (better) best = gamepad;
  }
  return best;
}

// Why no controller is visible, in words the player can act on.
function padProblem() {
  if (!window.isSecureContext) return 'Keyboard only: open the https:// address to use a controller.';
  if (!gamepadsAvailable()) return 'Keyboard only: this browser does not share controllers with pages.';
  return 'No controller seen yet: press a button on it, or press ? for keyboard controls.';
}

function nativeInput(now) {
  return nativeState && now - nativeStateAt < NATIVE_INPUT_STALE_MS ? nativeState : null;
}

// Once per visit, a few seconds into playing with nothing to play with: say
// what the options are, instead of leaving a picture that ignores everyone.
let inputHinted = false;
function hintAboutInput() {
  if (inputHinted) return;
  const generation = playGeneration;
  setTimeout(() => {
    const idle = !activeGamepad() && !nativeInput(performance.now()) && !keyboardUsed && !padWanted;
    if (inputHinted || generation !== playGeneration || !streaming || !idle) return;
    inputHinted = true;
    showToast(padProblem(), 6000);
  }, 3000);
}

function pollController() {
  const gamepad = activeGamepad();
  const now = performance.now();
  const native = nativeInput(now);
  const indicator = $('pad-indicator');
  const label = gamepad || native ? 'Controller' : keyboardUsed ? 'Keyboard' : 'No controller';
  if (indicator.textContent !== label) {
    indicator.dataset.on = String(Boolean(gamepad || native || keyboardUsed));
    indicator.textContent = label;
    // The longer explanation is one tap away, under the status.
    $('pad-hint').textContent = gamepad || native ? '' : keyboardUsed ? 'Press ? to see which keys do what.' : padProblem();
    showHud();
  }
  if (inputChannel?.readyState !== 'open') return;

  const state = mergeStates(readGamepad(gamepad, virtualButtons), keyboardState(heldKeys), padState, native);
  if (statesEqual(state, lastSent) && now - lastSentAt < RESEND_INTERVAL_MS) return;
  inputChannel.send(encodeState(state));
  lastSent = state;
  lastSentAt = now;
}

// Tells the Mac what this browser can see, so input problems show in its log.
function sendDiag() {
  const pads = gamepadsAvailable()
    ? [...navigator.getGamepads()].filter(Boolean).map((pad) => ({
      id: pad.id, mapping: pad.mapping, buttons: pad.buttons.length, axes: pad.axes.length,
    }))
    : [];
  const pad = activeGamepad();
  sendControl({
    type: 'diag',
    secure: window.isSecureContext,
    api: gamepadsAvailable(),
    pads,
    pressed: pad ? pad.buttons.filter((button) => button.pressed).length : 0,
  });
}

// ---------------------------------------------------- keyboard and on-screen

// While playing, the keyboard is a controller. Keys still do their usual job
// in text fields, and Enter or Space on a focused control presses that control.
function onKeyDown(event) {
  const guideOpen = !$('keys').hidden;
  const asksForGuide = event.key === '?' || (event.code === 'Slash' && event.shiftKey);
  if (asksForGuide || (guideOpen && event.code === 'Escape')) {
    if (streaming || guideOpen) {
      event.preventDefault();
      toggleKeyGuide();
    }
    return;
  }
  if (!streaming || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, select, textarea')) return;
  const activates = ['Enter', 'NumpadEnter', 'Space'].includes(event.code);
  if (!isMappedKey(event.code) || (activates && target?.closest('button, a'))) {
    showHud(); // e.g. Tab: so the controls are reachable without a pointer
    return;
  }
  event.preventDefault();
  if (!event.repeat) pressedAt.set(event.code, performance.now());
  heldKeys.add(event.code);
  if (!keyboardUsed) keyboardUsed = true;
}

function onKeyUp(event) {
  if (!heldKeys.has(event.code)) return;
  event.preventDefault();
  afterMinimumPress(event.code, () => heldKeys.delete(event.code));
}

// Releases once the press has lasted MIN_PRESS_MS, unless it was pressed
// again in the meantime.
function afterMinimumPress(what, release) {
  const at = pressedAt.get(what);
  const left = MIN_PRESS_MS - (performance.now() - (at ?? 0));
  if (left <= 0) release();
  else setTimeout(() => { if (pressedAt.get(what) === at) release(); }, left);
}

function releaseAllInput() {
  heldKeys.clear();
  pressedAt.clear();
  padState = idleState();
  for (const button of document.querySelectorAll('#pad .held')) button.classList.remove('held');
}

function toggleKeyGuide() {
  const guide = $('keys');
  guide.hidden = !guide.hidden;
  releaseAllInput(); // Shift (for ?) is also L3; don't leave it held
  if (!guide.hidden) $('btn-keys-close').focus({ preventScroll: true });
  else document.activeElement?.blur?.();
}

let padWanted = false;
try { padWanted = localStorage.getItem('pad') === '1'; } catch { /* not remembered */ }

function updatePad() {
  $('pad').hidden = !(streaming && padWanted);
  $('btn-pad').setAttribute('aria-pressed', String(padWanted));
}

function togglePad() {
  padWanted = !padWanted;
  try { localStorage.setItem('pad', padWanted ? '1' : '0'); } catch { /* not remembered */ }
  if (!padWanted) releaseAllInput();
  updatePad();
}

// The on-screen controller's buttons stay down for as long as they are held,
// so they work for menus and games alike. Several can be held at once.
function setPadButton(element, down) {
  element.classList.toggle('held', down);
  const bit = BUTTON[element.dataset.button];
  const trigger = element.dataset.trigger;
  padState = { ...padState };
  if (bit) padState.buttons = down ? padState.buttons | bit : padState.buttons & ~bit;
  if (trigger) padState[trigger] = down ? 255 : 0;
}

function wirePad() {
  for (const element of document.querySelectorAll('#pad button')) {
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault(); // keeps focus (and the keyboard) on the game
      pressedAt.set(element, performance.now());
      setPadButton(element, true);
      // Keeps the button held if the finger slides off it a little.
      try { element.setPointerCapture(event.pointerId); } catch { /* released on pointerup instead */ }
    });
    const release = () => {
      if (!element.classList.contains('held')) return;
      afterMinimumPress(element, () => { if (element.classList.contains('held')) setPadButton(element, false); });
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
    element.addEventListener('contextmenu', (event) => event.preventDefault());
  }
}

function fillKeyGuide() {
  const table = $('keys-table');
  for (const [keys, action] of KEY_GUIDE) {
    const row = table.insertRow();
    row.insertCell().textContent = keys;
    row.insertCell().textContent = action;
  }
}

// The Vision Pro app reads the controller itself and hands it to the page.
window.ps5NativeInput = (state) => {
  if (!state || typeof state !== 'object') return;
  const int = (value, low, high) => Math.max(low, Math.min(high, Math.round(Number(value) || 0)));
  nativeState = {
    buttons: int(state.buttons, 0, 0xffff),
    l2: int(state.l2, 0, 255),
    r2: int(state.r2, 0, 255),
    lx: int(state.lx, -32767, 32767),
    ly: int(state.ly, -32767, 32767),
    rx: int(state.rx, -32767, 32767),
    ry: int(state.ry, -32767, 32767),
  };
  nativeStateAt = performance.now();
};

// Presses an on-screen button briefly, as a tap on a real one would.
function tapVirtual(bit) {
  virtualButtons |= bit;
  setTimeout(() => { virtualButtons &= ~bit; }, TAP_BUTTON_MS);
}

function rumble(left, right) {
  nativeBridge()?.postMessage({ type: 'rumble', left, right });
  const actuator = activeGamepad()?.vibrationActuator;
  if (!actuator?.playEffect) return;
  if (!left && !right) {
    actuator.reset?.();
    return;
  }
  // The console says when rumble changes, not how long it lasts: keep going
  // until it sends the next level (zero stops it, above).
  actuator.playEffect('dual-rumble', {
    duration: 5000,
    strongMagnitude: Math.min(1, left / 255),
    weakMagnitude: Math.min(1, right / 255),
  }).catch(() => {});
}

// ------------------------------------------------------------------- stats

// The three bars in the corner of the bar: how much of the picture the PS5
// sends is actually reaching the screen, averaged over a few seconds so a
// single hiccup doesn't make them flicker.
function updateSignal(decodedFps, packetsLost) {
  if (!streaming) return;
  recentFps.push(decodedFps);
  if (recentFps.length > 3) recentFps.shift();
  const wanted = Number($('opt-fps').value) || 60;
  const share = recentFps.reduce((sum, fps) => sum + fps, 0) / recentFps.length / wanted;
  const level = share >= 0.85 && packetsLost === 0 ? 3 : share >= 0.6 ? 2 : 1;
  $('signal').dataset.level = String(level);
  $('btn-status').title = ['', 'Poor connection', 'Fair connection', 'Good connection'][level];

  poorSamples = level === 1 ? poorSamples + 1 : 0;
  if (poorSamples >= STRUGGLING_AFTER_S && !strugglingHinted) {
    strugglingHinted = true; // once per visit is enough
    const lighter = Number($('opt-res').value) > 720 ? '720p' : $('opt-net').value === 'strong' ? 'the lighter Wi-Fi setting' : '30 fps';
    showToast(`The connection is struggling. End, then choose ${lighter} under Picture for a smoother game.`, 8000);
  }
}

async function sampleStats(connection) {
  if (pc !== connection) return;
  sendDiag();
  let report;
  try {
    report = await connection.getStats();
  } catch {
    return;
  }
  let inbound = null;
  report.forEach((entry) => {
    if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry;
  });
  if (!inbound || pc !== connection) return;

  const previous = previousVideoStats;
  previousVideoStats = inbound;
  if (!previous) return;

  const decoded = (inbound.framesDecoded ?? 0) - (previous.framesDecoded ?? 0);
  const bytes = (inbound.bytesReceived ?? 0) - (previous.bytesReceived ?? 0);
  // Data is arriving but nothing is being drawn: the decoder has lost its
  // place (or never found it). A fresh keyframe gets it going again.
  stalledSamples = streaming && bytes > 0 && decoded === 0 ? stalledSamples + 1 : 0;
  if (stalledSamples >= 2 || (inbound.pliCount ?? 0) > (previous.pliCount ?? 0)) {
    stalledSamples = 0;
    sendControl({ type: 'keyframe' });
  }
  // The Mac itself is getting no picture from the PS5. Reconnecting this page
  // to the Mac would not help; say what is happening and wait for it.
  const macStarved = streaming && serverStats?.fps === 0;
  starvedSamples = macStarved ? starvedSamples + 1 : 0;
  if (starvedSamples === 3) showToast('Waiting for the PS5: its connection to the Mac dropped out…', 5000);
  // No new picture for several seconds even after asking for a keyframe:
  // reconnect, at most once every 15 seconds.
  frozenSamples = streaming && decoded === 0 && !macStarved ? frozenSamples + 1 : 0;
  if (frozenSamples >= AUTO_REFRESH_AFTER_S && Date.now() - lastAutoRefresh > AUTO_REFRESH_MIN_GAP_MS) {
    frozenSamples = 0;
    refresh({ auto: true });
    return;
  }
  updateSignal(decoded, (inbound.packetsLost ?? 0) - (previous.packetsLost ?? 0));

  const parts = [];
  if (inbound.frameWidth) parts.push(`${inbound.frameHeight}p`);
  // When fewer frames are shown than the Mac passed on, the loss is between
  // the Mac and this screen; when the Mac got few itself, it is at the PS5.
  const sent = serverStats?.fps;
  parts.push(Number.isFinite(sent) && Math.abs(sent - decoded) > 6 ? `${decoded} fps shown, ${sent} sent by the Mac` : `${decoded} fps`);
  parts.push(`${((bytes * 8) / 1e6).toFixed(1)} Mbps`);
  const emitted = (inbound.jitterBufferEmittedCount ?? 0) - (previous.jitterBufferEmittedCount ?? 0);
  if (emitted > 0) {
    const delay = ((inbound.jitterBufferDelay ?? 0) - (previous.jitterBufferDelay ?? 0)) / emitted;
    parts.push(`${Math.round(delay * 1000)} ms buffer`);
  }
  const lost = (inbound.packetsLost ?? 0) - (previous.packetsLost ?? 0);
  if (lost > 0) parts.push(`${lost} lost`);
  // How many controller updates per second the Mac is receiving.
  if (serverStats) parts.push(`input ${serverStats.inputHz}/s`);
  $('stats').textContent = parts.join(' · ');
}

// ------------------------------------------------------------------ wiring

$('btn-play').addEventListener('click', () => play());
$('btn-again').addEventListener('click', () => play());
$('btn-settings').addEventListener('click', () => {
  showPanel('panel-start');
  $('options').open = true;
  loadStatus();
});
$('btn-refresh').addEventListener('click', () => refresh());
$('volume').addEventListener('input', () => {
  muted = false;
  applyVolume();
  showHud();
});
$('btn-mute').addEventListener('click', () => {
  muted = !muted;
  applyVolume();
});
$('code-input').addEventListener('input', () => {
  const input = $('code-input');
  input.value = input.value.replace(/\D/g, '').slice(0, 6);
  if (input.value.length !== 6) return;
  accessCode = input.value;
  try { localStorage.setItem('access-code', accessCode); } catch { /* asked again next visit */ }
  input.value = '';
  loadStatus();
});
$('btn-tap').addEventListener('click', startPlayback);
$('btn-cancel').addEventListener('click', () => {
  teardown();
  showPanel('panel-start');
  loadStatus();
});
// The Mac answers a stop with "ended". If the link to it is already gone,
// there is nobody to ask: just go back to the start.
function stopSession(sleep) {
  if (controlChannel?.readyState === 'open') {
    sendControl({ type: 'stop', sleep });
    return;
  }
  teardown();
  showPanel('panel-start');
  loadStatus();
}
$('btn-end').addEventListener('click', () => stopSession(false));
$('btn-rest').addEventListener('click', () => stopSession(true));
$('btn-ps').addEventListener('click', () => tapVirtual(BUTTON.PS));
$('btn-touchpad').addEventListener('click', () => tapVirtual(BUTTON.TOUCHPAD));
$('btn-menu').addEventListener('click', () => toggleDropdown('menu'));
$('btn-status').addEventListener('click', () => toggleDropdown('details'));
// Choosing something from "More" puts the menu away again.
$('menu').addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('button')) setOpen('menu', false);
});
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
$('btn-pad').addEventListener('click', togglePad);
$('btn-keys').addEventListener('click', toggleKeyGuide);
$('btn-keys-close').addEventListener('click', toggleKeyGuide);
// After a mouse click, hand the keyboard back to the game, so Space or Enter
// presses ✕ on the PS5 instead of clicking the same button again.
hud.addEventListener('click', (event) => {
  if (event.detail > 0 && event.target instanceof Element) event.target.closest('button')?.blur();
});
wirePad();
fillKeyGuide();
$('panel-pin').addEventListener('submit', (event) => {
  event.preventDefault();
  const pin = $('pin-input').value.trim();
  if (!/^\d{4,8}$/.test(pin)) return;
  sendControl({ type: 'pin', pin });
  showProgress(PROGRESS_TEXT.connecting);
});

// Looking at the picture and pinching (or clicking) brings the controls back.
video.addEventListener('click', showHud);
hud.addEventListener('click', showHud);
window.addEventListener('pointermove', showHud);
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
// A key let go while another window had focus never reports its release.
window.addEventListener('blur', releaseAllInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllInput(); });
window.addEventListener('gamepadconnected', loadStatus);

// Remember the start-screen choices between visits.
for (const id of ['opt-res', 'opt-fps', 'opt-net']) {
  const select = $(id);
  try {
    const saved = localStorage.getItem(id);
    if (saved && [...select.options].some((option) => option.value === saved)) select.value = saved;
  } catch {
    // storage unavailable (private browsing); defaults are fine
  }
  select.addEventListener('change', () => {
    try { localStorage.setItem(id, select.value); } catch { /* see above */ }
    summarizeOptions();
  });
}

// What is chosen, on the closed "Picture" line: no need to open it to check.
function summarizeOptions() {
  const net = $('opt-net').value === 'weak' ? 'lighter stream' : 'sharpest picture';
  $('options-summary').textContent = `${$('opt-res').value}p · ${$('opt-fps').value} fps · ${net}`;
}
summarizeOptions();

showPanel('panel-start');
loadStatus();
