/**
 * AXON Protocol — Binary Frame Encoder/Decoder
 *
 * Frame Layout (8 bytes header + variable payload):
 * ┌───────┬──────────┬──────┬───────┬────────┐
 * │ Magic │ StreamID │ Type │ Flags │ Length  │
 * │ 1B    │ 2B       │ 1B   │ 1B    │ 4B (LE)│
 * └───────┴──────────┴──────┴───────┴────────┘
 */

import { Frame, FrameType, FrameFlag, FRAME_HEADER_SIZE } from "./types.js";

const MAGIC = 0xaa;

export function encodeFrame(frame: Frame): Uint8Array {
  const header = new Uint8Array(FRAME_HEADER_SIZE);
  const view = new DataView(header.buffer);

  view.setUint8(0, MAGIC);
  view.setUint16(1, frame.streamId, false); // big-endian stream ID
  view.setUint8(3, frame.type);
  view.setUint8(4, frame.flags);
  // Payload length: 3 bytes (up to 16MB per frame)
  const len = frame.payload.byteLength;
  view.setUint8(5, (len >> 16) & 0xff);
  view.setUint8(6, (len >> 8) & 0xff);
  view.setUint8(7, len & 0xff);

  const out = new Uint8Array(FRAME_HEADER_SIZE + len);
  out.set(header, 0);
  out.set(frame.payload, FRAME_HEADER_SIZE);
  return out;
}

export function decodeFrame(data: Uint8Array): { frame: Frame; bytesRead: number } | null {
  if (data.byteLength < FRAME_HEADER_SIZE) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const magic = view.getUint8(0);
  if (magic !== MAGIC) {
    throw new AxonFrameError(`Invalid magic byte: 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`);
  }

  const streamId = view.getUint16(1, false);
  const type = view.getUint8(3) as FrameType;
  const flags = view.getUint8(4);
  const length = (view.getUint8(5) << 16) | (view.getUint8(6) << 8) | view.getUint8(7);

  const totalSize = FRAME_HEADER_SIZE + length;
  if (data.byteLength < totalSize) return null; // Incomplete frame

  const payload = data.slice(FRAME_HEADER_SIZE, totalSize);

  return {
    frame: { magic: MAGIC, streamId, type, flags, payload },
    bytesRead: totalSize,
  };
}

export function hasFlag(flags: number, flag: FrameFlag): boolean {
  return (flags & flag) !== 0;
}

export function setFlag(flags: number, flag: FrameFlag): number {
  return flags | flag;
}

export function clearFlag(flags: number, flag: FrameFlag): number {
  return flags & ~flag;
}

export class AxonFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AxonFrameError";
  }
}

/**
 * Frame stream reader — buffers incoming bytes and yields complete frames.
 */
export class FrameReader {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    // Append chunk to buffer
    const newBuf = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    newBuf.set(this.buffer, 0);
    newBuf.set(chunk, this.buffer.byteLength);
    this.buffer = newBuf;

    const frames: Frame[] = [];
    while (true) {
      const result = decodeFrame(this.buffer);
      if (!result) break;

      frames.push(result.frame);
      this.buffer = this.buffer.slice(result.bytesRead);
    }

    return frames;
  }

  get pending(): number {
    return this.buffer.byteLength;
  }
}
