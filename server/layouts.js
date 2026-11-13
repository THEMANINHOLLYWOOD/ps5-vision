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
import { BINDABLE_KEYS, MOUSE_KEYS, TARGETS, sanitizeLayout } from '../web/keyboard.js';

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

const SYSTEM = 'You set up keyboard-and-mouse controls for PlayStation 5 games that are being played '
  + 'remotely from a computer. Given a game, you assign keyboard keys and mouse buttons to the '
  + 'controller\'s buttons the way a PC player of that game would expect, and say what each '
  + 'controller button does in that game. You reply only with the requested JSON.';

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
  one to three words, lower case: "reload", "jump", "light attack".
- about: one short sentence on how the layout is arranged.`;
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
  },
  required: ['game', 'recognized', 'mouseLook', 'keys', 'labels', 'about'],
});

// Asks Claude. image: a JPEG as a Buffer, or null when only a name is known.
// Resolves with its raw answer (an object); it still has to be sanitized.
export function askClaude({ claudePath, image = null, gameName = '', timeoutMs = ASK_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } });
    content.push({ type: 'text', text: layoutRequest(gameName) });

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
      '--json-schema', ANSWER_SCHEMA,
      '--model', MODEL,
      '--system-prompt', SYSTEM,
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
      if (!answer || typeof answer !== 'object') finish(new Error('Claude answered, but not with a layout.'));
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
