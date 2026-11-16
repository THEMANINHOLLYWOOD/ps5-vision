// The pilot: Claude drives the PS5 for you.
//
// "Open YouTube." "Switch to Astro Bot." "Go to the home screen." The bridge
// looks at the PS5's screen, Claude says which buttons to press, the bridge
// presses them, and round it goes until the PS5 is where you asked. You watch
// it happen on your own screen.
//
// It is the same Claude as for the layouts: Claude Code on this Mac, with no
// tools, shown one picture at a time. It can only answer with button names,
// and the bridge presses nothing but the buttons named below. It is told
// never to buy, delete, sign out or close a game that is running: when the
// PS5 asks about any of that, it stops and says what the PS5 is asking.

import { runClaude } from './layouts.js';
import { BUTTON } from '../web/controller.js';

// Many looks in a row, each one waited for: the quicker model. PS5VISION_PILOT_MODEL overrides.
const MODEL = process.env.PS5VISION_PILOT_MODEL || 'claude-sonnet-5-5';
const STEP_TIMEOUT_MS = 90_000;
const MAX_STEPS = 14;
const MAX_PRESSES = 6;
const PRESS_MS = 110;
const HOLD_MS = 1100;
const BETWEEN_PRESSES_MS = 650;
const SETTLE_MS = 1200;

// What the pilot may press. PS_HOLD is the PS button held down (the home screen).
export const PILOT_BUTTONS = Object.freeze([
  'CROSS', 'CIRCLE', 'SQUARE', 'TRIANGLE',
  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT',
  'L1', 'R1', 'OPTIONS', 'PS', 'PS_HOLD',
]);

const SYSTEM = `You operate a PlayStation 5 for its owner by pressing controller buttons. Each turn you are shown the screen as it is now, the owner's goal, and what you saw and pressed so far. You answer with what you see and the next buttons to press, and nothing else.

How the PS5 is driven:
- PS (a short press) opens the control centre, a row of icons along the bottom, over whatever is running; pressing it again closes it. The row starts with Home, then the Switcher (recent games and apps), then notifications, friends, music, downloads, sound, mic, controller, profile, power.
- PS_HOLD (the PS button held down) goes straight to the home screen.
- On the home screen, games are a row of tiles near the top. L1 and R1 switch between Games and Media at the very top. DPAD_LEFT and DPAD_RIGHT move along the row; the Game Library is at its far right. Media apps (YouTube, Netflix, Spotify and so on) are under Media.
- The highlighted item has a bright outline. CROSS opens it, CIRCLE goes back, OPTIONS opens its menu.
- A game that is already running resumes when its tile is opened.

Rules:
- Do only what the goal asks: get to the game, app or screen named, and stop there.
- Never buy, subscribe, download, delete, sign out, change a setting, type text, or choose anything under Power.
- A PS5 runs one game at a time. Opening a game while a different game is running closes the running one, often without asking, and anything unsaved in it is lost. So before you open a game, work out whether another game is running (the control centre's Switcher shows it, and its tile comes first on the home row). If one is, open the new game only when the goal says in so many words that the running game may be closed ("close it", "quit Call of Duty", "I've saved"). Otherwise set stuck, and in "say" name the running game and tell the owner to ask again saying it may be closed. Media apps (YouTube, Spotify, Netflix) do not close a game: open those freely.
- If the PS5 asks whether to close a running game or app, or anything that could lose progress or cost money, do not answer it: set stuck, and in "say" tell the owner what the PS5 is asking so they can choose with their own controller.
- When the goal is reached, set done. If you cannot get there, or the same thing keeps happening, set stuck and say why.

Reply fields:
- seen: what is on screen and what is highlighted, in a few words.
- press: the buttons to press now, in order, at most ${MAX_PRESSES}. Each is pressed once with a pause after it. Only: ${PILOT_BUTTONS.join(', ')}. Empty when done or stuck.
- say: one short sentence for the owner about what you are doing, in plain words.
- done, stuck: as above.`;

const STEP_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    seen: { type: 'string' },
    press: { type: 'array', items: { type: 'string' } },
    say: { type: 'string' },
    done: { type: 'boolean' },
    stuck: { type: 'boolean' },
  },
  required: ['seen', 'press', 'say', 'done', 'stuck'],
});

const plain = (value, max) => String(value ?? '').replace(/[\s\p{Cc}]+/gu, ' ').replace(/[<>{}`]/g, '').trim().slice(0, max);

// What the owner typed, as a plain sentence before it goes anywhere.
export function cleanGoal(text) {
  return plain(text, 140);
}

// Claude's answer, with anything that is not a button it may press removed.
export function sanitizeStep(raw) {
  const press = (Array.isArray(raw?.press) ? raw.press : []).filter((name) => PILOT_BUTTONS.includes(name)).slice(0, MAX_PRESSES);
  const done = raw?.done === true;
  const stuck = !done && (raw?.stuck === true || press.length === 0);
  return {
    seen: plain(raw?.seen, 160),
    say: plain(raw?.say, 160) || (done ? 'Done.' : stuck ? 'I could not get there.' : 'Working on it…'),
    press: done || stuck ? [] : press,
    done,
    stuck,
  };
}

// The controller state for one of the pilot's buttons, and how long to hold it.
export function pressFor(name) {
  const bits = name === 'PS_HOLD' ? BUTTON.PS : BUTTON[name] ?? 0;
  return { buttons: bits, holdMs: name === 'PS_HOLD' ? HOLD_MS : PRESS_MS };
}

export function askPilot({ claudePath, image, goal, history }) {
  const so_far = history.length
    ? `So far:\n${history.map((line, i) => `${i + 1}. ${line}`).join('\n')}`
    : 'This is the first look.';
  return runClaude({
    claudePath,
    system: SYSTEM,
    schema: STEP_SCHEMA,
    model: MODEL,
    image,
    text: `The owner's goal: ${goal}\n\n${so_far}\n\nThe picture is the PS5's screen right now. What do you press next?`,
    timeoutMs: STEP_TIMEOUT_MS,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs until the goal is reached, the pilot is stuck, it is stopped, or it
// has looked MAX_STEPS times. look() resolves with a JPEG of the screen,
// press(buttons, holdMs) presses, say(text) tells the owner.
// Resolves with { done, say, steps }.
export async function pilot({ goal, look, press, say = () => {}, ask, stopped = () => false, maxSteps = MAX_STEPS, pause = sleep }) {
  const history = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    if (stopped()) return { done: false, say: 'Stopped.', steps: step - 1 };
    const image = await look();
    const answer = sanitizeStep(await ask({ image, goal, history }));
    if (stopped()) return { done: false, say: 'Stopped.', steps: step - 1 };
    if (answer.done || answer.stuck) return { done: answer.done, say: answer.say, steps: step };
    say(answer.say);
    for (const name of answer.press) {
      const { buttons, holdMs } = pressFor(name);
      await press(buttons, holdMs);
      await pause(BETWEEN_PRESSES_MS);
    }
    history.push(`saw: ${answer.seen}; pressed: ${answer.press.join(', ')}`);
    await pause(SETTLE_MS);
  }
  return { done: false, say: `Not there after ${maxSteps} looks, so I stopped.`, steps: maxSteps };
}
