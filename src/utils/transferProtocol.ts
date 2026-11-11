import { computeSha256HexSync } from './crypto';

export const CHUNK_BYTE_SIZE = 16384; // 16 KiB per SCTP frame for universal WebRTC DataChannel compatibility
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 65536; // 64 KiB
export const BUFFERED_AMOUNT_HIGH_WATERMARK = 262144; // 256 KiB
export const ACK_BATCH_INTERVAL = 8; // Receiver sends CHUNK_ACK every 8 chunks or on final chunk
export const CHUNK_HEADER_BYTES = 28; // 4B magic + 16B transferId + 4B chunkIndex + 4B payloadLength

export type TransferSourceType = 'file' | 'stage-region' | 'loopback-test';

export type DuplicatePolicy = 'skip' | 'keep_both' | 'overwrite';

export interface FileMetaControlMessage {
  type: 'FILE_META';
  transferId: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  sha256: string;
  source: TransferSourceType;
  captureLabel?: string;
  dimensions?: { width: number; height: number };
  timestamp: number;
}

export interface ChunkAckControlMessage {
  type: 'CHUNK_ACK';
  transferId: string;
  chunkIndex: number;
  receivedChunks: number;
  receivedBytes: number;
}

export interface FileCompleteControlMessage {
  type: 'FILE_COMPLETE';
  transferId: string;
  sha256: string;
}

export interface FileVerifiedControlMessage {
  type: 'FILE_VERIFIED';
  transferId: string;
  verified: boolean;
  expectedSha256: string;
  actualSha256: string;
  error?: string;
}

export interface TransferCancelControlMessage {
  type: 'TRANSFER_CANCEL';
  transferId: string;
  reason: 'sender_cancelled' | 'receiver_cancelled' | 'duplicate_skipped';
}

export type TossControlMessage =
  | FileMetaControlMessage
  | ChunkAckControlMessage
  | FileCompleteControlMessage
  | FileVerifiedControlMessage
  | TransferCancelControlMessage;

export interface DecodedChunkFrame {
  transferId: string;
  chunkIndex: number;
  payload: Uint8Array;
}

/**
 * Encodes a binary chunk with a 28-byte header:
 * [0..3]   'T','O','S','S' (0x54, 0x4f, 0x53, 0x53)
 * [4..19]  16-byte ASCII transferId (padded/truncated to 16 chars)
 * [20..23] uint32 big-endian chunkIndex
 * [24..27] uint32 big-endian payloadLength
 * [28..]   payload bytes
 */
export function encodeChunkFrame(
  transferId: string,
  chunkIndex: number,
  payload: Uint8Array
): ArrayBuffer {
  const buffer = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Magic 'TOSS'
  bytes[0] = 0x54;
  bytes[1] = 0x4f;
  bytes[2] = 0x53;
  bytes[3] = 0x53;

  const normalizedId = transferId.padEnd(16, ' ').slice(0, 16);
  for (let i = 0; i < 16; i++) {
    bytes[4 + i] = normalizedId.charCodeAt(i) & 0xff;
  }

  view.setUint32(20, chunkIndex >>> 0, false);
  view.setUint32(24, payload.byteLength >>> 0, false);
  bytes.set(payload, CHUNK_HEADER_BYTES);

  return buffer;
}

export function decodeChunkFrame(buffer: ArrayBuffer | Uint8Array): DecodedChunkFrame | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < CHUNK_HEADER_BYTES) return null;

  if (bytes[0] !== 0x54 || bytes[1] !== 0x4f || bytes[2] !== 0x53 || bytes[3] !== 0x53) {
    return null;
  }

  let idChars = '';
  for (let i = 0; i < 16; i++) {
    idChars += String.fromCharCode(bytes[4 + i]);
  }
  const transferId = idChars.trim();

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkIndex = view.getUint32(20, false);
  const payloadLength = view.getUint32(24, false);

  if (bytes.byteLength < CHUNK_HEADER_BYTES + payloadLength) {
    return null;
  }

  const payload = bytes.slice(CHUNK_HEADER_BYTES, CHUNK_HEADER_BYTES + payloadLength);
  return {
    transferId,
    chunkIndex,
    payload,
  };
}

export function shouldPauseForBackpressure(
  bufferedAmount: number,
  highWatermark = BUFFERED_AMOUNT_HIGH_WATERMARK
): boolean {
  return bufferedAmount >= highWatermark;
}

export function shouldSendBatchAck(chunkIndex: number, totalChunks: number): boolean {
  if (totalChunks <= 0) return true;
  if (chunkIndex + 1 >= totalChunks) return true;
  return (chunkIndex + 1) % ACK_BATCH_INTERVAL === 0;
}

export function reassembleChunks(chunks: Map<number, Uint8Array>, totalChunks: number, expectedByteSize: number): Uint8Array | null {
  if (chunks.size !== totalChunks) return null;
  const output = new Uint8Array(expectedByteSize);
  let offset = 0;
  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks.get(i);
    if (!chunk) return null;
    if (offset + chunk.byteLength > expectedByteSize) {
      return null;
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expectedByteSize) return null;
  return output;
}

export interface CompletedTransferSummary {
  transferId: string;
  name: string;
  size: number;
  sha256: string;
}

export function checkDuplicateTransfer(
  incomingMeta: Pick<FileMetaControlMessage, 'name' | 'size' | 'sha256'>,
  existingItems: CompletedTransferSummary[],
  policy: DuplicatePolicy
): {
  isDuplicate: boolean;
  action: 'accept' | 'skip' | 'rename' | 'overwrite';
  resolvedName: string;
  matchedTransferId?: string;
} {
  const match = existingItems.find(
    (item) => item.sha256 === incomingMeta.sha256 && item.size === incomingMeta.size
  );

  if (!match) {
    return {
      isDuplicate: false,
      action: 'accept',
      resolvedName: incomingMeta.name,
    };
  }

  if (policy === 'skip') {
    return {
      isDuplicate: true,
      action: 'skip',
      resolvedName: incomingMeta.name,
      matchedTransferId: match.transferId,
    };
  }

  if (policy === 'overwrite') {
    return {
      isDuplicate: true,
      action: 'overwrite',
      resolvedName: incomingMeta.name,
      matchedTransferId: match.transferId,
    };
  }

  // keep_both: append deterministic suffix before extension
  const dotIdx = incomingMeta.name.lastIndexOf('.');
  const suffix = ` (copy-${existingItems.length + 1})`;
  const resolvedName =
    dotIdx > 0
      ? `${incomingMeta.name.slice(0, dotIdx)}${suffix}${incomingMeta.name.slice(dotIdx)}`
      : `${incomingMeta.name}${suffix}`;

  return {
    isDuplicate: true,
    action: 'rename',
    resolvedName,
    matchedTransferId: match.transferId,
  };
}

/**
 * Generates a deterministic multi-chunk binary payload for the Phase 3 dev loopback integrity test.
 */
export function createDeterministicLoopbackPayload(byteLength = 140000): {
  bytes: Uint8Array;
  sha256: string;
  totalChunks: number;
} {
  const bytes = new Uint8Array(byteLength);
  let state = 0x13579bdf;
  for (let i = 0; i < byteLength; i++) {
    // Xorshift32 deterministic stream
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = (state >>> 0) & 0xff;
  }
  const sha256 = computeSha256HexSync(bytes);
  const totalChunks = Math.max(1, Math.ceil(byteLength / CHUNK_BYTE_SIZE));
  return { bytes, sha256, totalChunks };
}
