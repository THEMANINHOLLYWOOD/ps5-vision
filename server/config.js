// Where the linked console's details live. The registration key lets anything
// on the network start a Remote Play session, so the file is owner-only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const CONSOLE_FILE = path.join(CONFIG_DIR, 'console.json');
export const HELPER_PATH = path.join(ROOT, '.build', 'helper', 'ps5-helper');

const HEX32 = /^[0-9a-f]{32}$/i;

// Returns the linked console, or null if nothing has been linked yet.
// Throws if the file exists but is unusable, so a typo isn't silently ignored.
export function loadConsole(file = CONSOLE_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const data = JSON.parse(raw);
  if (typeof data.host !== 'string' || !data.host) throw new Error(`${file}: "host" is missing`);
  if (!HEX32.test(data.registKey ?? '')) throw new Error(`${file}: "registKey" must be 32 hex characters`);
  if (!HEX32.test(data.morning ?? '')) throw new Error(`${file}: "morning" must be 32 hex characters`);
  return {
    host: data.host,
    name: data.name ?? 'PS5',
    mac: data.mac ?? '',
    ps5: data.ps5 !== false,
    registKey: data.registKey.toLowerCase(),
    morning: data.morning.toLowerCase(),
  };
}

export function saveConsole(console_, file = CONSOLE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(console_, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
