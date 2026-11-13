// Minimal H.264 Annex B helpers. We never decode: we only need to know what
// kind of NAL units a buffer holds, and where access units begin.

export const NAL_SLICE = 1;
export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;
export const NAL_AUD = 9;

// Returns the nal_unit_type of every NAL in an Annex B buffer, in order.
export function nalTypes(buf) {
  const types = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      types.push(buf[i + 3] & 0x1f);
      i += 2;
    }
  }
  return types;
}

// The same for H.265 (HEVC), which keeps the type in other bits of the header.
export function hevcNalTypes(buf) {
  const types = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      types.push((buf[i + 3] >> 1) & 0x3f);
      i += 2;
    }
  }
  return types;
}

// hevc: the buffer is H.265 rather than H.264.
export function isKeyframe(buf, hevc = false) {
  // H.265 types 16 to 21 are the pictures a decoder can start from.
  if (hevc) return hevcNalTypes(buf).some((type) => type >= 16 && type <= 21);
  return nalTypes(buf).includes(NAL_IDR);
}

export function hasParameterSets(buf, hevc = false) {
  if (hevc) {
    const types = hevcNalTypes(buf);
    return types.includes(32) && types.includes(33) && types.includes(34); // VPS, SPS, PPS
  }
  const types = nalTypes(buf);
  return types.includes(NAL_SPS) && types.includes(NAL_PPS);
}

const AUD_START = Buffer.from([0, 0, 1, NAL_AUD]);

// Splits a continuous Annex B byte stream (as ffmpeg writes it) into access
// units, using access unit delimiters as boundaries. Used by the demo source;
// the PS5 helper already hands over whole frames.
export class AccessUnitSplitter {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    // Re-scan the last 3 bytes so a start code split across chunks is found.
    const scanFrom = Math.max(1, this.pending.length - 3);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let start = 0;
    let search = scanFrom;
    for (;;) {
      let idx = this.pending.indexOf(AUD_START, search);
      if (idx < 0) break;
      // A 4-byte start code (00 00 00 01) belongs to the unit it introduces.
      const boundary = idx > 0 && this.pending[idx - 1] === 0 ? idx - 1 : idx;
      if (boundary > start) this.onAccessUnit(this.pending.subarray(start, boundary));
      start = boundary;
      search = idx + AUD_START.length;
    }
    this.pending = start > 0 ? Buffer.from(this.pending.subarray(start)) : this.pending;
  }

  flush() {
    if (this.pending.length) this.onAccessUnit(this.pending);
    this.pending = Buffer.alloc(0);
  }
}
