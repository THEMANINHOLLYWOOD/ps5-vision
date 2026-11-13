#!/usr/bin/env node
// Checks the stream without a browser: connects to the running bridge the way
// the page does, counts what arrives for a few seconds, and says in plain
// words whether the PS5 and the Mac are doing their part.
//
//   npm run check             15 seconds
//   npm run check -- 60       a minute
//
// It takes over the stream from whoever is watching, and wakes the PS5 if it
// is asleep. Run it on the Mac the bridge runs on.

import ndc from 'node-datachannel';

const seconds = Math.max(5, Math.min(600, Number(process.argv[2]) || 15));
const base = `http://localhost:${process.env.PS5VISION_PORT ?? 8080}`;
const WAKE_PATIENCE_S = 90;

async function post(path, body) {
  let response;
  try {
    response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`The bridge is not running at ${base}. Start it with: npm start`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `The bridge answered ${response.status}.`);
  return data;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

async function main() {
  const startedAt = Date.now();
  const offer = await post('/api/connect', { res: 1080, fps: 60, bitrate: 8000 });
  const pc = new ndc.PeerConnection('check', { iceServers: [] });
  // Everything is kept in these: a channel or track nobody holds on to is closed.
  const kept = [];
  let input = null;
  let frames = 0;
  let missing = 0;
  let lastSequence = null;
  let sentByMac = null;
  let streamingAt = null;
  let problem = null;
  const perSecond = [];
  const sentPerSecond = [];
  let missingTotal = 0;

  pc.onTrack((track) => {
    kept.push(track);
    if (track.mid() !== 'video') return;
    track.onMessage((packet) => {
      if (packet.length < 12) return;
      const type = packet[1] & 0x7f;
      if (type >= 64 && type <= 95) return; // reports about the stream, not the stream
      const sequence = packet.readUInt16BE(2);
      const step = lastSequence === null ? 1 : (sequence - lastSequence) & 0xffff;
      if (step > 1 && step < 1000) missing += step - 1; // anything else is a late or repeated packet
      lastSequence = sequence;
      if (packet[1] & 0x80) frames++; // the last packet of each picture is marked
    });
  });
  pc.onDataChannel((channel) => {
    kept.push(channel);
    if (channel.getLabel() === 'input') input = channel;
    if (channel.getLabel() !== 'control') return;
    channel.onMessage((raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message.type === 'stats') sentByMac = message.fps;
      else if (message.type === 'ended') problem = message.message ?? 'The session ended.';
      else if (message.type === 'pin_request') problem = 'The PS5 is asking for its login passcode. Open the page in a browser once to enter it.';
      else if (message.type === 'state') {
        if (message.state === 'waking') console.log('Waking the PS5 (up to a minute)…');
        if (message.state === 'streaming' && !streamingAt) {
          streamingAt = Date.now();
          console.log(`The stream started after ${((streamingAt - startedAt) / 1000).toFixed(1)} seconds. Watching it for ${seconds} seconds…`);
        }
      }
    });
  });

  const gathered = new Promise((resolve) => {
    pc.onGatheringStateChange((state) => { if (state === 'complete') resolve(); });
  });
  pc.setRemoteDescription(offer.sdp, 'offer');
  await gathered;
  await post('/api/answer', { id: offer.id, sdp: pc.localDescription().sdp });

  // The page sends the controller's state all the time; do the same, at rest.
  const idle = Buffer.alloc(14);
  const controller = setInterval(() => {
    try { if (input?.isOpen()) input.sendMessageBinary(idle); } catch { /* closing */ }
  }, 33);

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const waited = (Date.now() - startedAt) / 1000;
      if (problem || (!streamingAt && waited > WAKE_PATIENCE_S)) {
        problem ??= 'The stream never started. Is the PS5 plugged in and on the same network?';
      } else if (!streamingAt) {
        return;
      } else if (Date.now() - streamingAt >= 2000) { // the first moments are a burst
        perSecond.push(frames);
        if (Number.isFinite(sentByMac)) sentPerSecond.push(sentByMac);
        missingTotal += missing;
      }
      frames = 0;
      missing = 0;
      if (problem || (streamingAt && Date.now() - streamingAt >= (seconds + 2) * 1000)) {
        clearInterval(tick);
        resolve();
      }
    }, 1000);
  });
  clearInterval(controller);
  try { pc.close(); } catch { /* already closed */ }

  if (problem) {
    console.log(`\nCould not check the stream: ${problem}`);
    return 1;
  }
  const arrived = median(perSecond);
  const sent = median(sentPerSecond);
  const slowSeconds = perSecond.filter((count) => count < 50).length;
  console.log(`\nPictures a second: ${arrived} arrived, ${sent} sent on by the Mac (the PS5 sends 60).`);
  console.log(`Seconds with fewer than 50: ${slowSeconds} of ${perSecond.length}. Packets missing: ${missingTotal}.`);
  if (sent >= 55 && arrived >= 55 && slowSeconds <= perSecond.length * 0.1) {
    console.log('\nThe PS5 and this Mac are doing their part. If the game still stutters on your\n'
      + 'screen, the weak point is the Wi-Fi between this Mac and that screen: move\n'
      + 'closer to the router, or choose 720p under Play.');
    return 0;
  }
  if (sent < 55) {
    console.log('\nThe Mac is not getting a steady picture from the PS5. Plug the PS5 into the\n'
      + 'router with a cable if you can; otherwise choose 720p under Play.');
  } else {
    console.log('\nThe picture reaches the bridge but is held up inside this Mac. It is probably\n'
      + 'busy: close apps and browser tabs you are not using, then check again.');
  }
  return 1;
}

main().then((code) => {
  // Give the goodbye a moment to reach the bridge.
  setTimeout(() => process.exit(code), 300);
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
