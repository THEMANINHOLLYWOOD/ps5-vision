// Pulls Opus packets out of an Ogg stream. Only the demo source needs this
// (ffmpeg can't write bare Opus packets to a pipe); the PS5 sends bare packets.

const CAPTURE = Buffer.from('OggS');
const PAGE_HEADER_SIZE = 27;

export class OggOpusReader {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.pending = Buffer.alloc(0);
    this.partial = [];
    this.packetIndex = 0;
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    for (;;) {
      if (this.pending.length - offset < PAGE_HEADER_SIZE) break;
      if (!this.pending.subarray(offset, offset + 4).equals(CAPTURE)) {
        // Lost sync: skip ahead to the next page.
        const next = this.pending.indexOf(CAPTURE, offset + 1);
        if (next < 0) {
          offset = Math.max(offset, this.pending.length - 3);
          break;
        }
        offset = next;
        continue;
      }
      const segmentCount = this.pending[offset + 26];
      const tableEnd = offset + PAGE_HEADER_SIZE + segmentCount;
      if (this.pending.length < tableEnd) break;
      let bodySize = 0;
      for (let i = 0; i < segmentCount; i++) bodySize += this.pending[offset + PAGE_HEADER_SIZE + i];
      if (this.pending.length < tableEnd + bodySize) break;

      let cursor = tableEnd;
      for (let i = 0; i < segmentCount; i++) {
        const size = this.pending[offset + PAGE_HEADER_SIZE + i];
        this.partial.push(this.pending.subarray(cursor, cursor + size));
        cursor += size;
        // A segment shorter than 255 bytes ends the packet.
        if (size < 255) this.#finishPacket();
      }
      offset = tableEnd + bodySize;
    }
    this.pending = offset < this.pending.length ? Buffer.from(this.pending.subarray(offset)) : Buffer.alloc(0);
  }

  #finishPacket() {
    const packet = Buffer.concat(this.partial);
    this.partial = [];
    // The first two packets are OpusHead and OpusTags, not audio.
    if (this.packetIndex++ >= 2 && packet.length) this.onPacket(packet);
  }
}
