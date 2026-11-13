// Is this Mac sending its own screen somewhere over Wi-Fi? Mac Virtual Display
// (to a Vision Pro), Sidecar (to an iPad) and AirPlay mirroring all use the
// Mac's Wi-Fi radio directly, device to device. While they run, the radio
// keeps leaving the home network's channel, and everything else on Wi-Fi,
// this stream included, gets late and lossy. It is the commonest reason for
// a laggy game when the network itself is fine, so the bridge looks for it
// and says so.

import { execFile } from 'node:child_process';

// From `system_profiler SPDisplaysDataType -json`: the name of a wireless
// display, or null. Mac Virtual Display and Sidecar both appear as a virtual
// "Sidecar Display" connected over AirPlay.
export function wirelessDisplayIn(report) {
  for (const card of report?.SPDisplaysDataType ?? []) {
    for (const display of card?.spdisplays_ndrvs ?? []) {
      const overAirPlay = display?.spdisplays_connection_type === 'spdisplays_airplay';
      const virtual = display?.spdisplays_virtualdevice === 'spdisplays_yes';
      if (!overAirPlay && !virtual) continue;
      return /sidecar/i.test(display._name ?? '') ? 'Mac Virtual Display or Sidecar' : 'AirPlay';
    }
  }
  return null;
}

// Resolves with the wireless display's name, or null (also when it can't tell).
export function wirelessDisplay({ timeoutMs = 5000 } = {}) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(wirelessDisplayIn(JSON.parse(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}
