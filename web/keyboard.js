// Playing with a keyboard: which key stands for which controller button or
// stick, and how a set of held keys becomes a controller state. No DOM access
// here, so it can be unit-tested in Node.

import { BUTTON, idleState } from './controller.js';

const STICK = 32767;

// KeyboardEvent.code -> what it does. Codes name the physical key, so the
// layout stays the same on AZERTY or Dvorak keyboards.
export const KEY_MAP = Object.freeze({
  // Menus
  ArrowUp: { button: BUTTON.DPAD_UP },
  ArrowDown: { button: BUTTON.DPAD_DOWN },
  ArrowLeft: { button: BUTTON.DPAD_LEFT },
  ArrowRight: { button: BUTTON.DPAD_RIGHT },
  Enter: { button: BUTTON.CROSS },
  NumpadEnter: { button: BUTTON.CROSS },
  Space: { button: BUTTON.CROSS },
  Backspace: { button: BUTTON.CIRCLE },
  Escape: { button: BUTTON.CIRCLE },
  // Face buttons laid out like the controller's: I on top, J left, L right, K below
  KeyK: { button: BUTTON.CROSS },
  KeyL: { button: BUTTON.CIRCLE },
  KeyJ: { button: BUTTON.SQUARE },
  KeyI: { button: BUTTON.TRIANGLE },
  // Shoulders
  KeyQ: { button: BUTTON.L1 },
  KeyE: { button: BUTTON.R1 },
  KeyZ: { trigger: 'l2' },
  KeyC: { trigger: 'r2' },
  ShiftLeft: { button: BUTTON.L3 },
  KeyV: { button: BUTTON.R3 },
  // System
  KeyO: { button: BUTTON.OPTIONS },
  KeyU: { button: BUTTON.SHARE },
  KeyP: { button: BUTTON.PS },
  KeyY: { button: BUTTON.TOUCHPAD },
  // Left stick
  KeyW: { axis: 'ly', direction: -1 },
  KeyS: { axis: 'ly', direction: 1 },
  KeyA: { axis: 'lx', direction: -1 },
  KeyD: { axis: 'lx', direction: 1 },
  // Right stick
  KeyT: { axis: 'ry', direction: -1 },
  KeyG: { axis: 'ry', direction: 1 },
  KeyF: { axis: 'rx', direction: -1 },
  KeyH: { axis: 'rx', direction: 1 },
  Numpad8: { axis: 'ry', direction: -1 },
  Numpad5: { axis: 'ry', direction: 1 },
  Numpad2: { axis: 'ry', direction: 1 },
  Numpad4: { axis: 'rx', direction: -1 },
  Numpad6: { axis: 'rx', direction: 1 },
});

// The guide shown with "?": [keys, what they do].
export const KEY_GUIDE = Object.freeze([
  ['Arrow keys', 'D-pad (move around menus)'],
  ['Enter, Space or K', '✕ (select)'],
  ['Backspace, Esc or L', '○ (back)'],
  ['J / I', '□ / △'],
  ['W A S D', 'Left stick'],
  ['T F G H', 'Right stick'],
  ['Q / E', 'L1 / R1'],
  ['Z / C', 'L2 / R2'],
  ['Left Shift / V', 'L3 / R3 (press the sticks)'],
  ['O', 'Options'],
  ['U', 'Create'],
  ['P', 'PS button (home)'],
  ['Y', 'Touchpad press'],
]);

export function isMappedKey(code) {
  return Object.hasOwn(KEY_MAP, code);
}

// Opposite directions held together cancel out, like a stick pushed nowhere.
export function keyboardState(heldCodes) {
  const state = idleState();
  for (const code of heldCodes) {
    const action = KEY_MAP[code];
    if (!action) continue;
    if (action.button) state.buttons |= action.button;
    else if (action.trigger) state[action.trigger] = 255;
    else if (action.axis) state[action.axis] += action.direction;
  }
  for (const axis of ['lx', 'ly', 'rx', 'ry']) state[axis] = Math.sign(state[axis]) * STICK;
  return state;
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
