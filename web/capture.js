// Plays a USB HDMI capture card (the PS5 plugged straight into the Mac) full
// screen with as little delay as the browser allows. Nothing goes over the
// network, so there is no Wi-Fi in the way.

const $ = (id) => document.getElementById(id);
const video = $('screen');
const hud = $('hud');
const overlay = $('overlay');

// Names capture cards usually report; the Mac's own camera and mic are skipped.
const CAPTURE_NAMES = /capture|hdmi|elgato|cam link|game|usb video|usb audio|uvc|av\b|hd60|4k|genki|razer ripsaw|avermedia|live gamer|macrosilicon|ms2109|ms2130/i;
const BUILT_IN = /facetime|built-in|macbook|iphone|continuity|airpods|studio display/i;

let stream = null;
let audioContext = null;
let hudTimer = null;
let starting = false;

function pickDefault(devices) {
  return devices.find((d) => CAPTURE_NAMES.test(d.label) && !BUILT_IN.test(d.label))
    ?? devices.find((d) => !BUILT_IN.test(d.label))
    ?? devices[0];
}

function fillSelect(select, devices, chosen) {
  select.innerHTML = '';
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || 'Unnamed device';
    select.append(option);
  }
  const none = document.createElement('option');
  none.value = 'none';
  none.textContent = 'No sound';
  if (select.id === 'opt-audio') select.append(none);
  if (chosen) select.value = chosen.deviceId;
}

function stopStream() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
  video.srcObject = null;
}

function enterFullscreen() {
  const stage = $('stage');
  if (document.fullscreenElement || document.webkitFullscreenElement) return;
  try {
    if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    else stage.webkitRequestFullscreen?.();
  } catch {
    // not allowed; the Fullscreen button still works
  }
}

function showHud() {
  if (!stream) return;
  hud.hidden = false;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { hud.hidden = true; }, 4000);
}

function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
}

async function start() {
  const note = $('cap-note');
  if (starting) return; // a second tap while the browser is still asking
  if (!navigator.mediaDevices?.getUserMedia) {
    note.textContent = 'This browser only allows capture devices on a secure page. Open the https:// address of the bridge, or use it on the Mac itself at http://localhost.';
    return;
  }
  starting = true;
  $('btn-start').disabled = true;
  enterFullscreen();
  stopStream();
  try {
    // Ask once so the browser reveals device names, then pick the capture card.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() =>
      navigator.mediaDevices.getUserMedia({ video: true }));
    probe.getTracks().forEach((track) => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const mics = devices.filter((d) => d.kind === 'audioinput');
    if (!cams.length) throw new Error('No video device found. Is the capture card plugged in?');

    const videoSelect = $('opt-video');
    const audioSelect = $('opt-audio');
    const wantedVideo = cams.find((d) => d.deviceId === videoSelect.value) ?? pickDefault(cams);
    const wantedAudio = audioSelect.value === 'none' ? null
      : mics.find((d) => d.deviceId === audioSelect.value) ?? pickDefault(mics);
    fillSelect(videoSelect, cams, wantedVideo);
    fillSelect(audioSelect, mics, wantedAudio);
    if (!wantedAudio) audioSelect.value = 'none';

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: wantedVideo.deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
      // Game sound, not a voice: switch off all the call-cleanup processing,
      // which adds delay and mangles music.
      audio: wantedAudio ? {
        deviceId: { exact: wantedAudio.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        latency: { ideal: 0 },
      } : false,
    });

    video.srcObject = new MediaStream(stream.getVideoTracks());
    await video.play().catch(() => {});

    // Sound through Web Audio in "interactive" mode: lower delay than letting
    // the video element play it.
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      // No fixed sample rate: some browsers refuse to connect a device that
      // runs at a different rate than the context.
      audioContext = new AudioContext({ latencyHint: 'interactive' });
      audioContext.createMediaStreamSource(new MediaStream(audioTracks)).connect(audioContext.destination);
      await audioContext.resume().catch(() => {});
    }

    const settings = stream.getVideoTracks()[0].getSettings();
    $('cap-info').textContent = `${settings.width}×${settings.height} · ${Math.round(settings.frameRate ?? 0)} fps`;
    overlay.hidden = true;
    $('stage').classList.add('playing');
    showHud();
  } catch (err) {
    stopStream();
    note.textContent = err.name === 'NotAllowedError'
      ? 'The browser was not allowed to use the capture card. Allow camera and microphone for this page and press Start again.'
      : err.message || String(err);
  } finally {
    starting = false;
    $('btn-start').disabled = false;
  }
}

$('btn-start').addEventListener('click', start);
$('btn-stop').addEventListener('click', () => {
  stopStream();
  hud.hidden = true;
  $('stage').classList.remove('playing');
  exitFullscreen();
  overlay.hidden = false;
});
$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) exitFullscreen();
  else enterFullscreen();
});
video.addEventListener('click', showHud);
window.addEventListener('pointermove', showHud);
window.addEventListener('keydown', showHud);
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (!stream) $('cap-note').textContent = 'A device was plugged in or removed. Press Start to pick it up.';
});
