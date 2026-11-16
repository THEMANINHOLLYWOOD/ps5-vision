// Keyboard layouts built for one game. The page sends a picture of what is
// on screen (or a game's name); Claude says which game it is and how a PC
// player would expect its keys laid out; the answer is checked, saved, and
// offered to every device that plays through this bridge.
//
// Claude is reached through Claude Code on this Mac (the `claude` command),
// with the login it already has: no API key to set up. It is run with no
// tools at all and none of the user's settings, so it can only answer.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BINDABLE_KEYS, BUTTON_TARGETS, HAND_GESTURES, MOUSE_KEYS, TARGETS, sanitizeLayout } from '../web/keyboard.js';

const MODEL = 'claude-opus-5-5';
const ASK_TIMEOUT_MS = 120_000;
const MAX_SAVED = 60;
export const MAX_IMAGE_BYTES = 1_200_000;

// Where the `claude` command lives, or null. PS5VISION_CLAUDE overrides.
export function findClaude(env = process.env) {
  const candidates = [
    env.PS5VISION_CLAUDE,
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'claude')),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // not there; try the next
    }
  }
  return null;
}

const SYSTEM = 'You set up controls for PlayStation 5 games that are being played remotely: '
  + 'keyboard and mouse for a computer, and bare-hand gestures for Apple Vision Pro. Given a game, '
  + 'you assign keys, mouse buttons and hand gestures to the controller\'s buttons the way a '
  + 'player of that game would expect, and say what each controller button does in that game. '
  + 'You reply only with the requested JSON.';

// A name typed by a player goes into the request: keep it to a plain title.
export function cleanGameName(name) {
  return String(name ?? '').replace(/[^\p{L}\p{N} :'&.!+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function layoutRequest(gameName) {
  const which = gameName
    ? `The player says the game is: ${gameName}.`
    : 'The picture shows the player\'s PS5 screen right now. Work out which game is being played or is '
      + 'selected on the PS5\'s home screen (its name is usually on screen).';
  return `${which}

Lay out the keyboard and mouse for this game:

- game: the game's title. If you cannot tell which game it is, set recognized to false, set game to
  "Unknown game", and give a sensible general-purpose layout.
- mouseLook: true if the right stick aims a camera or crosshair in this game (shooters and most 3D
  games); moving the mouse then moves the right stick. false where there is no free camera (most
  sports, fighting, racing and 2D games).
- keys: maps a key to a controller target. Follow the game's own default PC bindings if it has a PC
  version, otherwise what PC players of that genre are used to. Several keys may share a target.
  Give every controller target this game uses at least one key.
  Keys you may use: ${BINDABLE_KEYS.join(', ')}.
  Only when mouseLook is true, also: ${MOUSE_KEYS.join(', ')} (left, middle and right mouse button,
  and one notch of the wheel).
  Targets: ${Object.keys(TARGETS).join(', ')}. (LS_ and RS_ are the left and right stick pushed in a
  direction. With mouseLook true the mouse is the right stick, so RS_ targets are not needed.)
  The arrow keys, Enter and Backspace already work the menus (D-pad, CROSS, CIRCLE): do not bind them.
  Do not use Escape, Control, Alt or Command.
- labels: for each controller button the game uses (not the sticks), what it does in this game, in
  one to three words, lower case: "reload", "jump", "light attack". Include the D-pad directions
  the game uses (DPAD_UP and so on).
- about: one short sentence on how the layout is arranged.
- vision: the same game played in Apple Vision Pro with bare hands and no controller.
  - leftDrag, rightDrag: what that hand does when the player pinches thumb and index finger
    together and moves the hand: "LS" or "RS" (that stick, pushed the way the hand moves), "DPAD"
    (the four D-pad directions) or "NONE". Nearly always leftDrag "LS" and rightDrag "RS". Use
    "DPAD" for a hand only in games steered with the D-pad, and never the same value for both.
  - gestures: maps ${HAND_GESTURES.join(', ')} to a controller button. Each is the thumb touching
    that finger of that hand, and the button stays pressed for as long as they touch. The middle
    fingers are the quickest and can be held while the same hand's stick is in use: give them the
    two actions pressed most in the middle of play (in a shooter rightMiddle fires and leftMiddle
    aims; in a platformer rightMiddle jumps). Ring fingers get the next most used. The little
    fingers are slow and easy to trigger by accident: give them something occasional and
    harmless, or leave them out. A button goes on one gesture at most.
    Buttons: ${BUTTON_TARGETS.join(', ')}.
  - panel: up to 8 more of those buttons, most used first, that float under the screen for the
    player to look at and pinch. That takes about half a second, so choose actions that can wait:
    reload, switch weapon, map, inventory, pause. Leave out buttons that already have a gesture.`;
}

const ANSWER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    game: { type: 'string' },
    recognized: { type: 'boolean' },
    mouseLook: { type: 'boolean' },
    keys: { type: 'object', additionalProperties: { type: 'string' } },
    labels: { type: 'object', additionalProperties: { type: 'string' } },
    about: { type: 'string' },
    vision: {
      type: 'object',
      properties: {
        leftDrag: { type: 'string' },
        rightDrag: { type: 'string' },
        gestures: { type: 'object', additionalProperties: { type: 'string' } },
        panel: { type: 'array', items: { type: 'string' } },
      },
      required: ['leftDrag', 'rightDrag', 'gestures', 'panel'],
    },
  },
  required: ['game', 'recognized', 'mouseLook', 'keys', 'labels', 'about', 'vision'],
});

// Asks Claude. image: a JPEG as a Buffer, or null when only a name is known.
// Resolves with its raw answer (an object); it still has to be sanitized.
export function askClaude({ claudePath, image = null, gameName = '', timeoutMs = ASK_TIMEOUT_MS }) {
  return runClaude({ claudePath, system: SYSTEM, schema: ANSWER_SCHEMA, model: MODEL, image, text: layoutRequest(gameName), timeoutMs });
}

// One question to Claude, with an optional picture, answered as JSON of the
// given shape. Claude Code is run with no tools and none of the user's
// settings, in an empty folder: it can only answer.
export function runClaude({ claudePath, system, schema, text, image = null, model = MODEL, timeoutMs = ASK_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } });
    content.push({ type: 'text', text });

    let workDir;
    try {
      // An empty folder of its own: nothing of the project is in reach.
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5-vision-'));
    } catch (err) {
      reject(err);
      return;
    }
    const child = spawn(claudePath, [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', schema,
      '--model', model,
      '--system-prompt', system,
      '--restricted', // no settings, hooks or plugins of the user's
      '--tools', '', // nothing to act with: it can only answer
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ], { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rm(workDir, { recursive: true, force: true }, () => {});
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Claude took too long to answer.'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (text) => { out += text; });
    child.stderr.setEncoding('utf8').on('data', (text) => { err = (err + text).slice(-2000); });
    child.on('error', (error) => finish(new Error(`could not run ${claudePath}: ${error.message}`)));
    child.on('exit', (code) => {
      // One JSON object per line; the last "result" line carries the answer.
      let result = null;
      for (const line of out.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event?.type === 'result') result = event;
        } catch {
          // not JSON (blank line, progress output)
        }
      }
      if (!result || result.is_error) {
        const said = typeof result?.result === 'string' ? result.result : err.trim();
        finish(new Error(`Claude did not answer (exit ${code})${said ? `: ${said.slice(0, 300)}` : ''}`));
        return;
      }
      let answer = result.structured_output;
      if (!answer && typeof result.result === 'string') {
        try { answer = JSON.parse(result.result); } catch { /* handled below */ }
      }
      if (!answer || typeof answer !== 'object') finish(new Error('Claude answered, but not in the shape asked for.'));
      else finish(null, answer);
    });
    child.stdin.on('error', () => {}); // exited early; 'exit' reports it
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  });
}

// The layouts built so far, kept in one small file next to the other settings.
export class LayoutStore {
  constructor(file) {
    this.file = file;
    this.layouts = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Checked again on the way in: the file may have been edited by hand.
      if (Array.isArray(saved)) this.layouts = saved.map((layout) => sanitizeLayout({ ...layout, game: layout.name }));
    } catch {
      // none saved yet
    }
  }

  list() {
    return this.layouts;
  }

  save(layout) {
    this.layouts = [layout, ...this.layouts.filter((other) => other.id !== layout.id)].slice(0, MAX_SAVED);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.layouts, null, 2)}\n`, { mode: 0o600 });
  }
}

// Builds, checks and saves a layout. Returns { layout, recognized }.
export async function buildLayout({ claudePath, store, image, gameName, ask = askClaude }) {
  const name = cleanGameName(gameName);
  const answer = await ask({ claudePath, image, gameName: name });
  const recognized = answer.recognized !== false;
  const layout = sanitizeLayout(recognized || !name ? answer : { ...answer, game: name });
  if (recognized || name) store.save(layout);
  return { layout, recognized };
}
