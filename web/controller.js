// Turns a browser Gamepad into the 14-byte controller state the bridge sends
// to the console. No DOM access here, so it can be unit-tested in Node.

// Bit positions the console expects (they match chiaki's ChiakiControllerButton).
export const BUTTON = Object.freeze({
  CROSS: 1 << 0,
  CIRCLE: 1 << 1,
  SQUARE: 1 << 2,
  TRIANGLE: 1 << 3,
  DPAD_LEFT: 1 << 4,
  DPAD_RIGHT: 1 << 5,
  DPAD_UP: 1 << 6,
  DPAD_DOWN: 1 << 7,
  L1: 1 << 8,
  R1: 1 << 9,
  L3: 1 << 10,
  R3: 1 << 11,
  OPTIONS: 1 << 12,
  SHARE: 1 << 13,
  TOUCHPAD: 1 << 14,
  PS: 1 << 15,
});

// Index in the W3C "standard" gamepad layout -> console button.
// Indexes 6 and 7 are the analog triggers and are handled separately.
const STANDARD_LAYOUT = [
  [0, BUTTON.CROSS],
  [1, BUTTON.CIRCLE],
  [2, BUTTON.SQUARE],
  [3, BUTTON.TRIANGLE],
  [4, BUTTON.L1],
  [5, BUTTON.R1],
  [8, BUTTON.SHARE],
  [9, BUTTON.OPTIONS],
  [10, BUTTON.L3],
  [11, BUTTON.R3],
  [12, BUTTON.DPAD_UP],
  [13, BUTTON.DPAD_DOWN],
  [14, BUTTON.DPAD_LEFT],
  [15, BUTTON.DPAD_RIGHT],
  [16, BUTTON.PS],
  [17, BUTTON.TOUCHPAD],
];

export const STATE_SIZE = 14;

// Stick values this close to centre are treated as centred, so a resting
// stick doesn't produce a constant stream of tiny changes.
const STICK_REST = 0.02;

export function idleState() {
  return { buttons: 0, l2: 0, r2: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
}

function axisToInt16(value) {
  if (!Number.isFinite(value) || Math.abs(value) < STICK_REST) return 0;
  return Math.round(Math.max(-1, Math.min(1, value)) * 32767);
}

function triggerToByte(button) {
  if (!button) return 0;
  const value = typeof button.value === 'number' && button.value > 0 ? button.value : button.pressed ? 1 : 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

// extraButtons: bits to OR in, for on-screen buttons such as PS.
export function readGamepad(gamepad, extraButtons = 0) {
  const state = idleState();
  state.buttons = extraButtons;
  if (!gamepad) return state;
  for (const [index, bit] of STANDARD_LAYOUT) {
    if (gamepad.buttons[index]?.pressed) state.buttons |= bit;
  }
  // Headsets, tablets and some browsers keep the PS button for themselves
  // (on a Vision Pro it opens the Home View), and a page cannot change that.
  // Create and Options held together stand in for it.
  const combo = BUTTON.SHARE | BUTTON.OPTIONS;
  if ((state.buttons & combo) === combo) state.buttons = (state.buttons & ~combo) | BUTTON.PS;
  state.l2 = triggerToByte(gamepad.buttons[6]);
  state.r2 = triggerToByte(gamepad.buttons[7]);
  state.lx = axisToInt16(gamepad.axes[0]);
  state.ly = axisToInt16(gamepad.axes[1]);
  state.rx = axisToInt16(gamepad.axes[2]);
  state.ry = axisToInt16(gamepad.axes[3]);
  return state;
}

export function statesEqual(a, b) {
  return a.buttons === b.buttons && a.l2 === b.l2 && a.r2 === b.r2
    && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;
}

// Layout (little endian): buttons u32, l2 u8, r2 u8, lx i16, ly i16, rx i16, ry i16.
export function encodeState(state) {
  const bytes = new Uint8Array(STATE_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, state.buttons >>> 0, true);
  view.setUint8(4, state.l2);
  view.setUint8(5, state.r2);
  view.setInt16(6, state.lx, true);
  view.setInt16(8, state.ly, true);
  view.setInt16(10, state.rx, true);
  view.setInt16(12, state.ry, true);
  return bytes;
}
