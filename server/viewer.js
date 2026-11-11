// One browser watching the stream: a WebRTC peer connection carrying the
// console's H.264 and Opus untouched, plus two data channels.
//
//   'input'   browser -> Mac, unreliable + unordered: 14-byte controller states.
//             A late controller state is worthless, so it is never retransmitted.
//   'control' both ways, reliable: small JSON messages (status, keyframe
//             requests, login PIN, stop).

import { EventEmitter } from 'node:events';
import ndc from 'node-datachannel';
import { isKeyframe, hasParameterSets } from './h264.js';

const VIDEO_PAYLOAD_TYPE = 96;
const AUDIO_PAYLOAD_TYPE = 111;
const VIDEO_CLOCK = 90000;
const AUDIO_CLOCK = 48000;
// Keeps each RTP packet under a typical Wi-Fi MTU after SRTP/UDP/IP overhead.
const MAX_FRAGMENT_SIZE = 1200;
const PLAYOUT_DELAY_EXT_ID = 6;
const PLAYOUT_DELAY_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

function randomSsrc() {
  return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
}

export class Viewer extends EventEmitter {
  constructor({ id, portRangeBegin, portRangeEnd } = {}) {
    super();
    this.id = id;
    this.closed = false;
    this.ready = false;
    this.needKeyframe = true;
    this.header = null;
    this.audioTimestamp = Math.floor(Math.random() * 0xffff);
    this.audioFrameSize = 480;
    this.videoBytes = 0;
    this.videoFrames = 0;

    const config = { iceServers: [] };
    if (portRangeBegin && portRangeEnd) Object.assign(config, { portRangeBegin, portRangeEnd });
    this.pc = new ndc.PeerConnection(`viewer-${id}`, config);

    // Advertised as Constrained Baseline (42e01f) because that is the one H.264
    // label Safari and Chrome both accept; each has its own, different label
    // for High profile and rejects the other's. Their decoders go by the
    // stream itself, so the console's High profile video plays regardless.
    const video = new ndc.Video('video', 'SendOnly');
    video.addH264Codec(VIDEO_PAYLOAD_TYPE, 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1');
    const videoSsrc = randomSsrc();
    video.addSSRC(videoSsrc, 'ps5', 'ps5-stream', 'ps5-video');
    // Ask the browser to show frames the moment they arrive instead of
    // buffering them for smoothness.
    video.parseSdpLine(`a=extmap:${PLAYOUT_DELAY_EXT_ID} ${PLAYOUT_DELAY_URI}`);
    this.videoTrack = this.pc.addTrack(video);
    this.videoConfig = new ndc.RtpPacketizationConfig(videoSsrc, 'ps5', VIDEO_PAYLOAD_TYPE, VIDEO_CLOCK);
    this.videoConfig.playoutDelayId = PLAYOUT_DELAY_EXT_ID;
    this.videoConfig.playoutDelayMin = 0;
    this.videoConfig.playoutDelayMax = 0;
    const videoPacketizer = new ndc.H264RtpPacketizer('StartSequence', this.videoConfig, MAX_FRAGMENT_SIZE);
    videoPacketizer.addToChain(new ndc.RtcpSrReporter(this.videoConfig));
    // Remembers recent packets so the browser can ask for ones Wi-Fi dropped.
    videoPacketizer.addToChain(new ndc.RtcpNackResponder(4096));
    this.videoTrack.setMediaHandler(videoPacketizer);

    const audio = new ndc.Audio('audio', 'SendOnly');
    audio.addOpusCodec(AUDIO_PAYLOAD_TYPE, 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1');
    const audioSsrc = randomSsrc();
    audio.addSSRC(audioSsrc, 'ps5', 'ps5-stream', 'ps5-audio');
    this.audioTrack = this.pc.addTrack(audio);
    this.audioConfig = new ndc.RtpPacketizationConfig(audioSsrc, 'ps5', AUDIO_PAYLOAD_TYPE, AUDIO_CLOCK);
    const audioPacketizer = new ndc.RtpPacketizer(this.audioConfig);
    audioPacketizer.addToChain(new ndc.RtcpSrReporter(this.audioConfig));
    this.audioTrack.setMediaHandler(audioPacketizer);

    this.input = this.pc.createDataChannel('input', { unordered: true, maxRetransmits: 0 });
    this.input.onMessage((msg) => {
      if (typeof msg !== 'string') this.emit('input', Buffer.from(msg));
    });

    this.control = this.pc.createDataChannel('control');
    this.control.onMessage((msg) => {
      if (typeof msg !== 'string') return;
      let parsed;
      try {
        parsed = JSON.parse(msg);
      } catch {
        return;
      }
      if (parsed && typeof parsed === 'object') this.emit('control', parsed);
    });
    this.control.onOpen(() => {
      this.ready = true;
      this.emit('open');
    });

    this.pc.onStateChange((state) => {
      this.emit('state', state);
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.close();
    });
  }

  // Resolves with the complete offer, ICE candidates included, so signaling
  // is a single round trip.
  createOffer({ timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        const description = this.pc.localDescription();
        if (description) resolve(description.sdp);
        else reject(new Error('no local description'));
      };
      // Creating the data channels already started the offer, and with no
      // outside servers to ask, listing this machine's addresses is instant:
      // it is normally finished by now. Waiting for a change that has already
      // happened would cost the whole timeout on every connect.
      if (this.pc.gatheringState() === 'complete') {
        done();
        return;
      }
      timer = setTimeout(done, timeoutMs);
      this.pc.onGatheringStateChange((state) => {
        if (state === 'complete') done();
      });
      if (this.pc.signalingState() === 'stable') this.pc.setLocalDescription('offer');
    });
  }

  acceptAnswer(sdp) {
    this.pc.setRemoteDescription(sdp, 'answer');
  }

  setHeader(header) {
    this.header = header;
  }

  setAudioFrameSize(samples) {
    if (samples > 0) this.audioFrameSize = samples;
  }

  // The next video sent will be a keyframe (later P-frames are held back
  // until one arrives). Used when the picture has to restart cleanly.
  resync() {
    this.needKeyframe = true;
  }

  // Returns false if the frame was not sent because this viewer is still
  // waiting for a keyframe.
  pushVideo(unit, tsUs) {
    if (this.closed || !this.videoTrack.isOpen()) return false;
    const key = isKeyframe(unit);
    if (this.needKeyframe && !key) return false;
    let payload = unit;
    // A decoder can only start on a keyframe that comes with its SPS/PPS; the
    // console sends those once, out of band, so re-attach them here.
    if (key && this.header && !hasParameterSets(unit)) payload = Buffer.concat([this.header, unit]);
    this.videoConfig.timestamp = Math.floor((tsUs * VIDEO_CLOCK) / 1e6) >>> 0;
    try {
      this.videoTrack.sendMessageBinary(payload);
    } catch {
      return false;
    }
    if (key) this.needKeyframe = false;
    this.videoBytes += payload.length;
    this.videoFrames++;
    return true;
  }

  pushAudio(packet) {
    if (this.closed || !this.audioTrack.isOpen()) return;
    this.audioConfig.timestamp = this.audioTimestamp;
    this.audioTimestamp = (this.audioTimestamp + this.audioFrameSize) >>> 0;
    try {
      this.audioTrack.sendMessageBinary(packet);
    } catch {
      // Track closed between the check and the send; the state callback cleans up.
    }
  }

  sendControl(message) {
    if (this.closed || !this.control.isOpen()) return;
    try {
      this.control.sendMessage(JSON.stringify(message));
    } catch {
      // Channel closed underneath us; the state callback cleans up.
    }
  }

  // Bytes and frames sent since the last call.
  takeStats() {
    const stats = { videoBytes: this.videoBytes, videoFrames: this.videoFrames };
    this.videoBytes = 0;
    this.videoFrames = 0;
    return stats;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    try {
      this.pc.close();
    } catch {
      // already closed
    }
    this.emit('closed');
  }
}
