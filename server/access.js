// Who may talk to the bridge.
//
// Two checks, both needed because the bridge has no accounts:
//
//  1. The Host header must be a name this machine really has. A web page
//     elsewhere can point its own domain at this machine's address ("DNS
//     rebinding") and then script the API as if it were our page; the browser
//     still sends that page's domain as Host, so refusing unknown hosts stops it.
//  2. Devices other than this machine must present the access code that the
//     bridge prints when it starts, so being on the same Wi-Fi is not enough
//     to control the console.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CODE_PATTERN = /^\d{6}$/;

// "Name.local:8443" -> "name.local", "[::1]:8080" -> "[::1]". Null if malformed.
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader || hostHeader.length > 255) return null;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(hostHeader.trim());
  return match ? match[1].toLowerCase() : null;
}

export function hostAllowed(hostHeader, allowedNames) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  for (const allowed of allowedNames) if (allowed.toLowerCase() === name) return true;
  return false;
}

export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// Compares in constant time, so the answer's timing doesn't leak digits.
export function codesMatch(given, expected) {
  if (typeof given !== 'string' || !CODE_PATTERN.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// The code is made once and kept, so devices that already entered it keep
// working across restarts. Delete the file to get a new one.
export function loadOrCreateAccessCode(file) {
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (CODE_PATTERN.test(saved)) return saved;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return code;
}

// Slows guessing to a crawl. A device that sends a handful of wrong codes is
// locked out for the rest of the window, without locking out anyone else; a
// larger overall limit covers a guesser that keeps changing address. A
// million codes at a hundred a minute is still a week of non-stop trying.
export class AttemptLimiter {
  constructor({ max = 10, maxOverall = 100, windowMs = 60_000 } = {}) {
    this.max = max;
    this.maxOverall = maxOverall;
    this.windowMs = windowMs;
    this.failures = []; // { key, at }
  }

  blocked(key, now = Date.now()) {
    this.failures = this.failures.filter((failure) => now - failure.at < this.windowMs);
    if (this.failures.length >= this.maxOverall) return true;
    return this.failures.filter((failure) => failure.key === key).length >= this.max;
  }

  fail(key, now = Date.now()) {
    this.failures.push({ key, at: now });
  }
}
