// Announces the bridge on the local network with Bonjour, so the Vision Pro
// app finds it without anyone typing an address. Uses macOS's own dns-sd
// tool, so there is nothing to install; elsewhere it quietly does nothing.

import { spawn } from 'node:child_process';

export const SERVICE_TYPE = '_ps5vision._tcp';

// TXT records are key=value strings of at most 255 bytes each.
export function txtRecord(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/[^\x20-\x7e]/g, '')}`.slice(0, 255));
}

// Returns a function that withdraws the announcement.
export function advertise({ name, port, txt = {}, log = () => {} }) {
  if (process.platform !== 'darwin') return () => {};
  let child;
  try {
    child = spawn('dns-sd', ['-R', name, SERVICE_TYPE, 'local', String(port), ...txtRecord(txt)], {
      stdio: 'ignore',
    });
  } catch (err) {
    log(`could not announce the bridge on the network: ${err.message}`);
    return () => {};
  }
  child.on('error', (err) => log(`could not announce the bridge on the network: ${err.message}`));
  child.unref();
  const stop = () => { try { child.kill(); } catch { /* already gone */ } };
  process.once('exit', stop);
  return stop;
}
