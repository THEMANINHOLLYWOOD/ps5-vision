// A panel: the picture that is already playing, or one part of it, in a
// window of its own. See panel.html.

// (No page when the tests load this file for readCrop.)
const video = globalThis.document?.getElementById('screen');
const note = globalThis.document?.getElementById('note');
const RETRY_MS = 3000;

// ?crop=x,y,width,height, each a share of the whole picture (0 to 1).
export function readCrop(search) {
  const parts = (new URLSearchParams(search).get('crop') ?? '').split(',').map(Number);
  const whole = { x: 0, y: 0, width: 1, height: 1 };
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return whole;
  const width = Math.min(1, Math.max(0.02, parts[2]));
  const height = Math.min(1, Math.max(0.02, parts[3]));
  return {
    x: Math.min(1 - width, Math.max(0, parts[0])),
    y: Math.min(1 - height, Math.max(0, parts[1])),
    width,
    height,
  };
}

if (video) {
  const crop = readCrop(location.search);
  video.style.width = `${100 / crop.width}%`;
  video.style.height = `${100 / crop.height}%`;
  video.style.left = `${(-crop.x / crop.width) * 100}%`;
  video.style.top = `${(-crop.y / crop.height) * 100}%`;

  const say = (text) => {
    note.textContent = text;
    note.hidden = !text;
  };
  video.addEventListener('playing', () => say(''));

  let pc = null;
  let retry = null;
  const again = (text) => {
    if (text) say(text);
    pc?.close();
    pc = null;
    clearTimeout(retry);
    retry = setTimeout(connect, RETRY_MS);
  };

  const post = async (path, body) => {
    const headers = { 'content-type': 'application/json' };
    try {
      const code = localStorage.getItem('access-code');
      if (code) headers['x-access-code'] = code;
    } catch { /* no code kept on this device */ }
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error ?? 'The bridge said no.'), { status: response.status });
    return data;
  };

  const kept = []; // channels nobody holds on to are closed
  let control = null;

  // A picture can only start on a keyframe. If video is arriving and none of
  // it can be drawn (the keyframe was lost on the way, or this panel joined
  // just after one), ask the Mac for another.
  let before = null;
  let stuck = 0;
  setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') {
      before = null;
      return;
    }
    let now = null;
    try {
      for (const report of (await pc.getStats()).values()) {
        if (report.type === 'inbound-rtp' && report.kind === 'video') now = report;
      }
    } catch { /* closing */ }
    if (!now) return;
    const arriving = (now.bytesReceived ?? 0) > (before?.bytesReceived ?? 0);
    const drawn = (now.framesDecoded ?? 0) > (before?.framesDecoded ?? 0);
    const asked = (now.pliCount ?? 0) > (before?.pliCount ?? 0);
    stuck = before && arriving && !drawn ? stuck + 1 : 0;
    before = now;
    if ((stuck >= 2 || asked) && control?.readyState === 'open') {
      stuck = 0;
      control.send(JSON.stringify({ type: 'keyframe' }));
    }
  }, 1000);
  async function connect() {
    let offer;
    try {
      offer = await post('/api/connect', { panel: true });
    } catch (err) {
      again(err.status === 409 ? 'Waiting for the game to start…' : err.message);
      return;
    }
    const connection = new RTCPeerConnection();
    pc = connection;
    connection.addEventListener('datachannel', (event) => {
      kept.push(event.channel);
      if (event.channel.label === 'control') control = event.channel;
    });
    connection.addEventListener('track', (event) => {
      if (event.track.kind !== 'video') return;
      // As little delay as the browser will allow: this is a live picture.
      if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
      if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      video.play().catch(() => {});
    });
    connection.addEventListener('connectionstatechange', () => {
      if (pc !== connection) return;
      if (['failed', 'closed', 'disconnected'].includes(connection.connectionState)) again(held ? '' : 'Reconnecting…');
    });
    try {
      await connection.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      await connection.setLocalDescription(await connection.createAnswer());
      await post('/api/answer', { id: offer.id, sdp: connection.localDescription.sdp });
    } catch (err) {
      if (pc === connection) again(err.message);
    }
  }

  // Held: the panel keeps the picture it had, like a card of that moment,
  // while the game goes on elsewhere. Let go, and it is live again.
  let held = false;
  window.ps5Freeze = (on) => {
    held = Boolean(on);
    document.getElementById('held').hidden = !held;
    if (held) video.pause();
    else video.play().catch(() => {});
  };

  connect();
}
