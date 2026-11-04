// ConnectCIC transport frame, as used by the interface agent's TCP mode and legacy DEx
// (DEx: ConnectCicFrame.java, EchoServer.java; agent: ia/tcp/ConnectCicFrame.java).
//
//   5A F0 C3 0F | length (4, big endian, whole frame) | header length (2) | ackId (2) | type (1) | reserved (3) | body | C3 0F 5A F0
//
// The length counts everything, start and end markers included, so an empty-body frame is 20 bytes.

export const START = Buffer.from([0x5a, 0xf0, 0xc3, 0x0f]);
export const END = Buffer.from([0xc3, 0x0f, 0x5a, 0xf0]);

export const FrameType = {
  MESSAGE_NO_ACK: 0x00,
  MESSAGE_ACK: 0x01,
  ENCRYPTED_NO_ACK: 0x02,
  ENCRYPTED_ACK: 0x03,
  ACK: 0x10,
  NAK: 0x11,
};
const KNOWN_TYPES = new Set(Object.values(FrameType));

const HEADER_LENGTH = 8;
const OVERHEAD = START.length + 4 + HEADER_LENGTH + END.length; // 20
const MIN_FRAME = 14; // the reference readers accept anything from 14 bytes up
export const MAX_FRAME = 1024 * 1024;

export const isAckRequired = (type) => type === FrameType.MESSAGE_ACK || type === FrameType.ENCRYPTED_ACK;
export const isEncrypted = (type) => type === FrameType.ENCRYPTED_NO_ACK || type === FrameType.ENCRYPTED_ACK;

export function encodeFrame({ type, ackId = 0, body = Buffer.alloc(0) }) {
  const payload = Buffer.from(body);
  const total = OVERHEAD + payload.length;
  const out = Buffer.alloc(total);
  START.copy(out, 0);
  out.writeUInt32BE(total, 4);
  out.writeUInt16BE(HEADER_LENGTH, 8);
  out.writeUInt16BE(ackId & 0xffff, 10);
  out[12] = type;
  payload.copy(out, 8 + HEADER_LENGTH);
  END.copy(out, total - END.length);
  return out;
}

/**
 * Incremental decoder for a TCP byte stream. push() takes whatever the socket delivered (partial
 * frames, several frames, noise between frames) and returns the complete frames found, plus a list of
 * short error strings for anything it had to skip. It never throws and never buffers more than one
 * maximum-size frame, so a hostile or broken peer cannot make it grow without bound.
 */
export class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames = [];
    const errors = [];
    for (;;) {
      const start = this.buf.indexOf(START);
      if (start === -1) {
        // Keep a possible partial start marker at the end; drop the rest.
        const keep = START.length - 1;
        if (this.buf.length > keep) {
          errors.push(`discarded ${this.buf.length - keep} bytes with no frame start`);
          this.buf = this.buf.subarray(this.buf.length - keep);
        }
        break;
      }
      if (start > 0) {
        errors.push(`skipped ${start} bytes before frame start`);
        this.buf = this.buf.subarray(start);
      }
      if (this.buf.length < 8) break;
      const total = this.buf.readUInt32BE(4);
      if (total < MIN_FRAME || total > MAX_FRAME) {
        errors.push(`impossible frame length ${total}`);
        this.buf = this.buf.subarray(1); // resync on the next start marker
        continue;
      }
      if (this.buf.length < total) break;
      const raw = this.buf.subarray(0, total);
      if (!raw.subarray(total - END.length).equals(END)) {
        errors.push('missing end marker');
        this.buf = this.buf.subarray(1);
        continue;
      }
      this.buf = this.buf.subarray(total);
      const headerLength = raw.readUInt16BE(8);
      if (headerLength < 5 || 8 + headerLength > total - END.length) {
        errors.push(`bad header length ${headerLength}`);
        continue;
      }
      const type = raw[12];
      if (!KNOWN_TYPES.has(type)) {
        errors.push(`unknown frame type 0x${type.toString(16)}`);
        continue;
      }
      frames.push({ type, ackId: raw.readUInt16BE(10), body: Buffer.from(raw.subarray(8 + headerLength, total - END.length)) });
    }
    return { frames, errors };
  }
}
