// Playing with a keyboard and mouse: which key stands for which controller
// button or stick, in layouts to suit different games, and how a set of held
// keys becomes a controller state. No DOM access here, so it can be
// unit-tested in Node.

import { BUTTON, idleState } from './controller.js';

const STICK = 32767;

// Everything a key (or mouse button) can stand for, by name.
export const TARGETS = Object.freeze({
  CROSS: { button: BUTTON.CROSS },
  CIRCLE: { button: BUTTON.CIRCLE },
  SQUARE: { button: BUTTON.SQUARE },
  TRIANGLE: { button: BUTTON.TRIANGLE },
  L1: { button: BUTTON.L1 },
  R1: { button: BUTTON.R1 },
  L2: { trigger: 'l2' },
  R2: { trigger: 'r2' },
  L3: { button: BUTTON.L3 },
  R3: { button: BUTTON.R3 },
  DPAD_UP: { button: BUTTON.DPAD_UP },
  DPAD_DOWN: { button: BUTTON.DPAD_DOWN },
  DPAD_LEFT: { button: BUTTON.DPAD_LEFT },
  DPAD_RIGHT: { button: BUTTON.DPAD_RIGHT },
  OPTIONS: { button: BUTTON.OPTIONS },
  CREATE: { button: BUTTON.SHARE },
  PS: { button: BUTTON.PS },
  TOUCHPAD: { button: BUTTON.TOUCHPAD },
  LS_UP: { axis: 'ly', direction: -1 },
  LS_DOWN: { axis: 'ly', direction: 1 },
  LS_LEFT: { axis: 'lx', direction: -1 },
  LS_RIGHT: { axis: 'lx', direction: 1 },
  RS_UP: { axis: 'ry', direction: -1 },
  RS_DOWN: { axis: 'ry', direction: 1 },
  RS_LEFT: { axis: 'rx', direction: -1 },
  RS_RIGHT: { axis: 'rx', direction: 1 },
});

// What each is called on the controller, for the guide.
const TARGET_NAMES = Object.freeze({
  CROSS: '✕', CIRCLE: '○', SQUARE: '□', TRIANGLE: '△',
  L1: 'L1', R1: 'R1', L2: 'L2', R2: 'R2', L3: 'L3', R3: 'R3',
  OPTIONS: 'Options', CREATE: 'Create', PS: 'PS button', TOUCHPAD: 'Touchpad press',
});

// These work in every layout, so the PS5's own menus can always be used. The
// Pointer… ones are not keys: they are what a click, a right-click, a scroll
// or a swipe on the picture presses (see app.js).
const ALWAYS = Object.freeze({
  ArrowUp: 'DPAD_UP',
  ArrowDown: 'DPAD_DOWN',
  ArrowLeft: 'DPAD_LEFT',
  ArrowRight: 'DPAD_RIGHT',
  Enter: 'CROSS',
  NumpadEnter: 'CROSS',
  Backspace: 'CIRCLE',
  PointerSelect: 'CROSS',
  PointerBack: 'CIRCLE',
  PointerUp: 'DPAD_UP',
  PointerDown: 'DPAD_DOWN',
  PointerLeft: 'DPAD_LEFT',
  PointerRight: 'DPAD_RIGHT',
});

// KeyboardEvent.code -> target. Codes name the physical key, so a layout is
// the same on AZERTY or Dvorak keyboards. Mouse0/1/2 are the left, middle and
// right mouse buttons, WheelUp/WheelDown one notch of the wheel; those only
// count while the mouse is captured for looking around.
//
// Ctrl, Alt and Cmd are never used: with W, Q or a digit they close the tab
// or the browser. Esc is the browser's key for letting go of the mouse.
export const LAYOUTS = Object.freeze([
  {
    id: 'standard',
    name: 'Menus and any game',
    about: 'Everything on the keyboard. Click the picture to select, right-click to go back, scroll or drag to move.',
    mouseLook: false,
    keys: {
      Space: 'CROSS', Escape: 'CIRCLE',
      // Face buttons laid out like the controller's: I on top, J left, L right, K below
      KeyK: 'CROSS', KeyL: 'CIRCLE', KeyJ: 'SQUARE', KeyI: 'TRIANGLE',
      KeyQ: 'L1', KeyE: 'R1', KeyZ: 'L2', KeyC: 'R2', ShiftLeft: 'L3', KeyV: 'R3',
      KeyO: 'OPTIONS', KeyU: 'CREATE', KeyP: 'PS', KeyY: 'TOUCHPAD',
      KeyW: 'LS_UP', KeyS: 'LS_DOWN', KeyA: 'LS_LEFT', KeyD: 'LS_RIGHT',
      KeyT: 'RS_UP', KeyG: 'RS_DOWN', KeyF: 'RS_LEFT', KeyH: 'RS_RIGHT',
      Numpad8: 'RS_UP', Numpad5: 'RS_DOWN', Numpad2: 'RS_DOWN', Numpad4: 'RS_LEFT', Numpad6: 'RS_RIGHT',
    },
    labels: { CROSS: 'select', CIRCLE: 'back', PS: 'home' },
  },
  {
    id: 'pc',
    name: 'Keyboard and mouse, like on PC',
    about: 'For shooters and third-person games. Click the picture to capture the mouse; Esc lets it go.',
    mouseLook: true,
    keys: {
      KeyW: 'LS_UP', KeyS: 'LS_DOWN', KeyA: 'LS_LEFT', KeyD: 'LS_RIGHT',
      Mouse0: 'R2', Mouse2: 'L2', Mouse1: 'R3',
      Space: 'CROSS', KeyC: 'CIRCLE',
      KeyR: 'SQUARE', KeyF: 'SQUARE',
      Digit1: 'TRIANGLE', Digit2: 'TRIANGLE', WheelUp: 'TRIANGLE', WheelDown: 'TRIANGLE',
      KeyQ: 'L1', KeyE: 'R1', KeyG: 'R1',
      ShiftLeft: 'L3', KeyV: 'R3',
      KeyZ: 'DPAD_UP', KeyX: 'DPAD_DOWN', Digit3: 'DPAD_LEFT', Digit4: 'DPAD_RIGHT',
      Tab: 'TOUCHPAD', KeyM: 'TOUCHPAD',
      KeyO: 'OPTIONS', Backquote: 'OPTIONS', KeyU: 'CREATE', KeyP: 'PS',
      // Looking around without a mouse (a trackpad is poor at it)
      KeyI: 'RS_UP', KeyK: 'RS_DOWN', KeyJ: 'RS_LEFT', KeyL: 'RS_RIGHT',
    },
    labels: {
      R2: 'fire', L2: 'aim', CROSS: 'jump', CIRCLE: 'crouch or slide', SQUARE: 'reload or use',
      TRIANGLE: 'switch weapon', L1: 'tactical', R1: 'lethal', L3: 'sprint', R3: 'melee',
      TOUCHPAD: 'scoreboard or map', OPTIONS: 'menu', PS: 'home',
    },
  },
  {
    id: 'driving',
    name: 'Driving',
    about: 'W and S are the pedals, A and D steer.',
    mouseLook: false,
    keys: {
      KeyW: 'R2', KeyS: 'L2', KeyA: 'LS_LEFT', KeyD: 'LS_RIGHT',
      Space: 'CROSS', ShiftLeft: 'SQUARE', KeyC: 'CIRCLE', KeyF: 'TRIANGLE',
      KeyQ: 'L1', KeyE: 'R1', KeyZ: 'L3', KeyV: 'R3',
      KeyI: 'RS_UP', KeyK: 'RS_DOWN', KeyJ: 'RS_LEFT', KeyL: 'RS_RIGHT',
      KeyT: 'LS_UP', KeyG: 'LS_DOWN',
      Tab: 'TOUCHPAD', KeyO: 'OPTIONS', KeyU: 'CREATE', KeyP: 'PS',
    },
    labels: { R2: 'accelerate', L2: 'brake', PS: 'home' },
  },
]);

// `more`: layouts built for particular games (see sanitizeLayout).
export function findLayout(id, more = []) {
  return [...LAYOUTS, ...more].find((layout) => layout.id === id) ?? LAYOUTS[0];
}

// ---- Layouts built for one game
//
// The bridge can ask Claude to lay out the keyboard for whatever game is on
// screen. What comes back is a suggestion from outside this code, so it is
// only ever used after going through sanitizeLayout: unknown keys and targets
// are dropped, and whatever it left unreachable is filled in.

// Keys such a layout may use. Not here: the keys every layout already has
// (arrows, Enter, Backspace), Esc (the browser's key for letting go of the
// mouse), "/" (with Shift it opens the guide), and Ctrl, Alt and Cmd.
export const BINDABLE_KEYS = Object.freeze([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `Key${letter}`),
  ...'0123456789'.split('').map((digit) => `Digit${digit}`),
  'Space', 'Tab', 'ShiftLeft', 'ShiftRight', 'CapsLock', 'Backquote', 'Minus', 'Equal',
  'BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Comma', 'Period',
]);
export const MOUSE_KEYS = Object.freeze(['Mouse0', 'Mouse1', 'Mouse2', 'WheelUp', 'WheelDown']);

function plainText(value, max) {
  return String(value ?? '')
    .replace(/[\s\p{Cc}]+/gu, ' ') // line breaks and the like separate words
    .replace(/[^\p{L}\p{N}\p{P}\p{Zs}+]/gu, '') // symbols such as (R) and (TM) just go
    .replace(/[<>]/g, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, max);
}

export function layoutId(game) {
  const slug = plainText(game, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `game:${slug || 'unknown'}`;
}

export function sanitizeLayout(raw) {
  const name = plainText(raw?.game ?? raw?.name, 60) || 'This game';
  const mouseLook = Boolean(raw?.mouseLook);
  const allowed = new Set([...BINDABLE_KEYS, ...(mouseLook ? MOUSE_KEYS : [])]);
  const keys = {};
  for (const [code, target] of Object.entries(raw?.keys ?? {})) {
    if (allowed.has(code) && Object.hasOwn(TARGETS, target)) keys[code] = target;
  }
  const labels = {};
  for (const [target, label] of Object.entries(raw?.labels ?? {})) {
    const text = plainText(label, 28);
    if (Object.hasOwn(TARGET_NAMES, target) && text) labels[target] = text;
  }
  const layout = { id: layoutId(name), name, about: plainText(raw?.about, 160), mouseLook, keys, labels, built: true };

  // Every game must stay fully playable: give whatever was left out the key
  // it has in the nearest built-in layout, or failing that any free key.
  const base = LAYOUTS.find((candidate) => candidate.id === (mouseLook ? 'pc' : 'standard'));
  const spare = BINDABLE_KEYS.filter((code) => !Object.hasOwn(keys, code)).reverse();
  for (const target of unreachable(layout)) {
    const usual = Object.entries(base.keys).find(([code, bound]) => bound === target && allowed.has(code) && !Object.hasOwn(keys, code));
    const code = usual?.[0] ?? spare.find((candidate) => !Object.hasOwn(keys, candidate));
    if (code) keys[code] = target;
  }
  return layout;
}

// A layout as a lookup from key to what it does, with the keys that always
// work added. Bindings to anything unknown are left out.
export function compileLayout(layout) {
  const map = new Map();
  for (const [code, target] of Object.entries({ ...layout.keys, ...ALWAYS })) {
    if (TARGETS[target]) map.set(code, TARGETS[target]);
  }
  return map;
}

// Buttons and stick directions no key reaches in this layout. A layout that
// leaves any out cannot play every game.
export function unreachable(layout) {
  const bound = new Set(Object.values({ ...layout.keys, ...ALWAYS }));
  return Object.keys(TARGETS).filter((target) => {
    if (bound.has(target)) return false;
    return !(layout.mouseLook && target.startsWith('RS_')); // the mouse looks around
  });
}

const KEY_NAMES = Object.freeze({
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'Space', Enter: 'Enter', Backspace: 'Backspace', Escape: 'Esc', Tab: 'Tab',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', Backquote: '`',
  Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click',
  WheelUp: 'Wheel', WheelDown: 'Wheel',
});

export function keyName(code) {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

const GUIDE_ORDER = ['R2', 'L2', 'CROSS', 'CIRCLE', 'SQUARE', 'TRIANGLE', 'L1', 'R1', 'L3', 'R3',
  'TOUCHPAD', 'OPTIONS', 'CREATE', 'PS'];

// The guide shown with "?": rows of [keys, what they do].
export function guideFor(layout) {
  const keysFor = (...targets) => {
    const names = [];
    for (const target of targets) {
      for (const [code, bound] of Object.entries({ ...layout.keys, ...ALWAYS })) {
        if (bound !== target || code.startsWith('Pointer') || code === 'NumpadEnter' || code.startsWith('Numpad')) continue;
        const name = keyName(code);
        if (!names.includes(name)) names.push(name);
      }
    }
    return names;
  };
  const rows = [];
  const stick = (prefix, what) => {
    const keys = keysFor(`${prefix}_UP`, `${prefix}_LEFT`, `${prefix}_DOWN`, `${prefix}_RIGHT`);
    if (keys.length) rows.push([keys.join(' '), what]);
  };
  stick('LS', 'Left stick (move)');
  if (layout.mouseLook) rows.push(['Mouse', 'Right stick (look around)']);
  stick('RS', layout.mouseLook ? 'Right stick, without a mouse' : 'Right stick (look around)');
  for (const target of GUIDE_ORDER) {
    const keys = keysFor(target);
    if (!keys.length) continue;
    const label = layout.labels?.[target];
    rows.push([keys.join(' or '), label ? `${TARGET_NAMES[target]} (${label})` : TARGET_NAMES[target]]);
  }
  rows.push([keysFor('DPAD_UP', 'DPAD_LEFT', 'DPAD_DOWN', 'DPAD_RIGHT').join(' '), 'D-pad']);
  return rows;
}

// The first layout, as plain objects, for code that wants just one.
export const KEY_MAP = Object.freeze(Object.fromEntries(compileLayout(LAYOUTS[0])));
export const KEY_GUIDE = Object.freeze(guideFor(LAYOUTS[0]));

export function isMappedKey(code, map = KEY_MAP) {
  return map instanceof Map ? map.has(code) : Object.hasOwn(map, code);
}

// Opposite directions held together cancel out, like a stick pushed nowhere.
export function keyboardState(heldCodes, map = KEY_MAP) {
  const state = idleState();
  for (const code of heldCodes) {
    const action = map instanceof Map ? map.get(code) : map[code];
    if (!action) continue;
    if (action.button) state.buttons |= action.button;
    else if (action.trigger) state[action.trigger] = 255;
    else if (action.axis) state[action.axis] += action.direction;
  }
  for (const axis of ['lx', 'ly', 'rx', 'ry']) state[axis] = Math.sign(state[axis]) * STICK;
  return state;
}

// Mouse movement as a push of the right stick. A stick has no notion of
// distance, only of how far it is pushed, so speed stands in for it: `dx`
// and `dy` are the pixels moved over `ms` milliseconds, `sensitivity` is 1
// for a typical mouse. Games ignore the first part of a stick's travel (the
// "dead zone"); the smallest movement starts just beyond it, or slow, careful
// aiming would do nothing at all.
const FULL_PUSH_PX_PER_MS = 1.6;
const DEAD_ZONE = 0.22;

export function mouseToStick(dx, dy, ms, sensitivity = 1) {
  const speed = Math.hypot(dx, dy) / Math.max(1, ms);
  if (speed === 0) return { rx: 0, ry: 0 };
  const push = Math.min(1, DEAD_ZONE + (1 - DEAD_ZONE) * Math.min(1, (speed * sensitivity) / FULL_PUSH_PX_PER_MS));
  const length = Math.hypot(dx, dy);
  return { rx: Math.round((dx / length) * push * STICK), ry: Math.round((dy / length) * push * STICK) };
}

// Several inputs at once (controller, keyboard, on-screen buttons): a button
// is down if any of them holds it, and each stick and trigger follows
// whichever input pushes it furthest.
export function mergeStates(...states) {
  const out = idleState();
  for (const state of states) {
    if (!state) continue;
    out.buttons |= state.buttons;
    out.l2 = Math.max(out.l2, state.l2);
    out.r2 = Math.max(out.r2, state.r2);
    for (const axis of ['lx', 'ly', 'rx', 'ry']) {
      if (Math.abs(state[axis]) > Math.abs(out[axis])) out[axis] = state[axis];
    }
  }
  return out;
}
