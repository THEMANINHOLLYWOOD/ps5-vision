// Wire format shared with helper/main.c: [type:u8][length:u32le][payload].

const HEADER_SIZE = 5;
const DEFAULT_MAX_PAYLOAD = 32 * 1024 * 1024;

export function encodeFrame(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(HEADER_SIZE);
  head.writeUInt8(type.charCodeAt(0), 0);
  head.writeUInt32LE(payload.length, 1);
  return payload.length ? Buffer.concat([head, payload]) : head;
}

// Feed it arbitrary chunks from a pipe; it calls onFrame(type, payload) once
// per complete frame. A length above maxPayload means the stream is corrupt,
// so it throws rather than waiting forever for bytes that will never make sense.
export class FrameParser {
  constructor(onFrame, { maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
    this.onFrame = onFrame;
    this.maxPayload = maxPayload;
    this.pending = Buffer.alloc(0);
    this.dead = false;
  }

  push(chunk) {
    // After a corrupt length nothing later can be trusted either.
    if (this.dead) return;
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    while (buf.length - offset >= HEADER_SIZE) {
      const length = buf.readUInt32LE(offset + 1);
      if (length > this.maxPayload) {
        this.dead = true;
        this.pending = Buffer.alloc(0);
        throw new Error(`frame of ${length} bytes exceeds limit of ${this.maxPayload}`);
      }
      if (buf.length - offset < HEADER_SIZE + length) break;
      const type = String.fromCharCode(buf[offset]);
      const payload = buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length);
      offset += HEADER_SIZE + length;
      this.onFrame(type, payload);
    }
    // Copy the tail so we don't pin the whole chunk in memory.
    this.pending = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  }
}
