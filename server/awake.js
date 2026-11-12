// Keeps the Mac from falling asleep while a game is streaming. Nobody touches
// the Mac's keyboard while playing in a headset, so without this macOS would
// count it as idle and go to sleep mid-game. Uses macOS's own caffeinate.

import { spawn } from 'node:child_process';

// Returns a function that lets the Mac sleep again.
export function keepAwake() {
  if (process.platform !== 'darwin') return () => {};
  let child;
  try {
    // -i: no idle sleep. -w: let go by itself if the bridge dies.
    child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', () => {});
  } catch {
    return () => {};
  }
  return () => { try { child.kill(); } catch { /* already gone */ } };
}
