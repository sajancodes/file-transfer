import { computeCrc32Hex } from './crypto';

export type SignalRole = 'offer' | 'answer';

export interface TossSignalPayloadV1 {
  v: 1;
  type: SignalRole;
  sessionId: string;
  createdAt: number;
  ufrag: string;
  pwd: string;
  fingerprint: string;
  setup: 'actpass' | 'active' | 'passive';
  sctpPort: number;
  candidates: string[];
  rawSdp?: string;
}

export type SignalingFailureCode =
  | 'MALFORMED_PAYLOAD'
  | 'UNSUPPORTED_VERSION'
  | 'ROLE_MISMATCH'
  | 'EXPIRED_PAYLOAD'
  | 'ICE_GATHERING_TIMEOUT'
  | 'ICE_CONNECTION_FAILED'
  | 'CAMERA_PERMISSION_DENIED';

export interface SignalingErrorDetail {
  code: SignalingFailureCode;
  title: string;
  detail: string;
  recovery: string;
}

export const SIGNAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const QR_SINGLE_FRAME_MAX_CHARS = 480;
export const QR_MULTI_FRAME_CHUNK_CHARS = 240;

export const FAILURE_DESCRIPTIONS: Record<SignalingFailureCode, SignalingErrorDetail> = {
  MALFORMED_PAYLOAD: {
    code: 'MALFORMED_PAYLOAD',
    title: 'Malformed Signaling Payload',
    detail: 'The pasted token or .toss file failed CRC32 checksum verification or Base64URL decoding.',
    recovery: 'Re-copy the full TOSS1 string or export a fresh .toss file from the peer device.',
  },
  UNSUPPORTED_VERSION: {
    code: 'UNSUPPORTED_VERSION',
    title: 'Unsupported Protocol Version',
    detail: 'The signaling payload version does not match protocol v1 (TOSS1).',
    recovery: 'Ensure both devices are running Toss Protocol v1.',
  },
  ROLE_MISMATCH: {
    code: 'ROLE_MISMATCH',
    title: 'Signaling Role Mismatch',
    detail: 'Received an Offer payload while waiting for an Answer, or an Answer while expecting an Offer.',
    recovery: 'Peer A creates an Offer; Peer B imports the Offer and returns the generated Answer to Peer A.',
  },
  EXPIRED_PAYLOAD: {
    code: 'EXPIRED_PAYLOAD',
    title: 'Expired Signaling Payload',
    detail: 'This signaling payload was created more than 10 minutes ago and its ICE candidates have expired.',
    recovery: 'Generate a new Offer to gather fresh ICE candidates.',
  },
  ICE_GATHERING_TIMEOUT: {
    code: 'ICE_GATHERING_TIMEOUT',
    title: 'ICE Candidate Gathering Timed Out',
    detail: 'No usable host or server-reflexive ICE candidates were gathered within the timeout window.',
    recovery: 'Check local network interface permissions or disable restrictive WebRTC IP handling extensions.',
  },
  ICE_CONNECTION_FAILED: {
    code: 'ICE_CONNECTION_FAILED',
    title: 'Direct Peer Connection Failed',
    detail: 'STUN/host candidate pairs failed connectivity checks (symmetric NAT or firewall block).',
    recovery: 'Verify both devices share the same LAN or unrestricted Wi-Fi network and retry pairing.',
  },
  CAMERA_PERMISSION_DENIED: {
    code: 'CAMERA_PERMISSION_DENIED',
    title: 'Camera Access Denied or Unavailable',
    detail: 'Browser blocked getUserMedia video access required for live QR scanning.',
    recovery: 'Use Copy/Paste or .toss file import/export to complete pairing without a camera.',
  },
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

/**
 * Extracts essential WebRTC DataChannel SDP parameters and candidates so payloads fit cleanly into QR codes,
 * while preserving full lossless SDP reconstruction.
 */
export function extractSdpParameters(
  sdp: string,
  type: SignalRole,
  sessionId: string,
  createdAt = Date.now()
): TossSignalPayloadV1 {
  const lines = sdp.split(/\r?\n/);
  let ufrag = '';
  let pwd = '';
  let fingerprint = '';
  let setup: 'actpass' | 'active' | 'passive' = type === 'offer' ? 'actpass' : 'active';
  let sctpPort = 5000;
  const candidates: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('a=ice-ufrag:')) {
      ufrag = line.slice('a=ice-ufrag:'.length);
    } else if (line.startsWith('a=ice-pwd:')) {
      pwd = line.slice('a=ice-pwd:'.length);
    } else if (line.startsWith('a=fingerprint:')) {
      fingerprint = line.slice('a=fingerprint:'.length);
    } else if (line.startsWith('a=setup:')) {
      const val = line.slice('a=setup:'.length);
      if (val === 'actpass' || val === 'active' || val === 'passive') {
        setup = val;
      }
    } else if (line.startsWith('a=sctp-port:')) {
      const parsed = parseInt(line.slice('a=sctp-port:'.length), 10);
      if (Number.isFinite(parsed)) sctpPort = parsed;
    } else if (line.startsWith('a=candidate:')) {
      // Keep host and srflx UDP candidates for reliable P2P connectivity
      candidates.push(line.slice('a=candidate:'.length));
    }
  }

  return {
    v: 1,
    type,
    sessionId,
    createdAt,
    ufrag,
    pwd,
    fingerprint,
    setup,
    sctpPort,
    candidates: candidates.slice(0, 10),
    rawSdp: sdp,
  };
}

export function reconstructSdpFromPayload(payload: TossSignalPayloadV1): string {
  if (payload.rawSdp && payload.rawSdp.includes('v=0')) {
    return payload.rawSdp;
  }
  const candLines = payload.candidates.map((c) => `a=candidate:${c}`).join('\r\n');
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${payload.ufrag}`,
    `a=ice-pwd:${payload.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${payload.fingerprint}`,
    `a=setup:${payload.setup}`,
    'a=mid:0',
    `a=sctp-port:${payload.sctpPort || 5000}`,
    'a=max-message-size:262144',
  ];
  if (candLines) {
    lines.push(candLines);
  }
  return lines.join('\r\n') + '\r\n';
}

export function encodeSignalPayloadSync(
  payload: TossSignalPayloadV1,
  compactForQr = false
): string {
  const wireObj = compactForQr
    ? {
        v: payload.v,
        type: payload.type,
        sessionId: payload.sessionId,
        createdAt: payload.createdAt,
        ufrag: payload.ufrag,
        pwd: payload.pwd,
        fingerprint: payload.fingerprint,
        setup: payload.setup,
        sctpPort: payload.sctpPort,
        candidates: payload.candidates.slice(0, 6),
      }
    : payload;

  const json = JSON.stringify(wireObj);
  const bytes = new TextEncoder().encode(json);
  const b64 = toBase64Url(bytes);
  const crc = computeCrc32Hex(`v${payload.v}.${b64}`);
  return `TOSS1.RAW.${crc}.${b64}`;
}

export function decodeSignalPayloadSync(
  token: string,
  expectedRole?: SignalRole,
  now = Date.now()
): { ok: true; payload: TossSignalPayloadV1; sdp: string } | { ok: false; error: SignalingErrorDetail } {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
  }

  // Check if user pasted a JSON .toss wrapper
  let tokenToParse = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const parsedWrapper = JSON.parse(trimmed);
      if (typeof parsedWrapper.version === 'number' && parsedWrapper.version !== 1) {
        return { ok: false, error: FAILURE_DESCRIPTIONS.UNSUPPORTED_VERSION };
      }
      if (typeof parsedWrapper.token === 'string') {
        tokenToParse = parsedWrapper.token.trim();
      } else {
        return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
      }
    } catch {
      return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
    }
  }

  const parts = tokenToParse.split('.');
  if (parts.length !== 4) {
    return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
  }

  const [prefix, mode, crc, b64] = parts;
  if (prefix.startsWith('TOSS') && prefix !== 'TOSS1') {
    return { ok: false, error: FAILURE_DESCRIPTIONS.UNSUPPORTED_VERSION };
  }
  if (prefix !== 'TOSS1' || mode !== 'RAW') {
    return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
  }

  try {
    const bytes = fromBase64Url(b64);
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json) as TossSignalPayloadV1;

    if (typeof obj.v !== 'number') {
      return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
    }
    if (obj.v !== 1) {
      return { ok: false, error: FAILURE_DESCRIPTIONS.UNSUPPORTED_VERSION };
    }

    const expectedCrc = computeCrc32Hex(`v${obj.v}.${b64}`);
    if (crc !== expectedCrc) {
      return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
    }

    if (obj.type !== 'offer' && obj.type !== 'answer') {
      return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
    }

    if (expectedRole && obj.type !== expectedRole) {
      return { ok: false, error: FAILURE_DESCRIPTIONS.ROLE_MISMATCH };
    }

    if (typeof obj.createdAt !== 'number' || now - obj.createdAt > SIGNAL_TTL_MS) {
      return { ok: false, error: FAILURE_DESCRIPTIONS.EXPIRED_PAYLOAD };
    }

    const sdp = reconstructSdpFromPayload(obj);
    return { ok: true, payload: obj, sdp };
  } catch {
    return { ok: false, error: FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD };
  }
}

export interface MultiFramePacket {
  frameIndex: number; // 1-based
  totalFrames: number;
  sessionId: string;
  chunk: string;
  rawFrame: string;
}

export function splitTokenIntoQrFrames(
  token: string,
  sessionId: string,
  chunkSize = QR_MULTI_FRAME_CHUNK_CHARS
): MultiFramePacket[] {
  const safeChunkSize = Math.max(64, chunkSize);
  const totalFrames = Math.max(1, Math.ceil(token.length / safeChunkSize));
  const packets: MultiFramePacket[] = [];

  for (let i = 0; i < totalFrames; i++) {
    const chunk = token.slice(i * safeChunkSize, (i + 1) * safeChunkSize);
    const frameIndex = i + 1;
    const rawFrame = `TOSS1F|${frameIndex}/${totalFrames}|${sessionId}|${chunk}`;
    packets.push({
      frameIndex,
      totalFrames,
      sessionId,
      chunk,
      rawFrame,
    });
  }
  return packets;
}

export function parseQrFrameString(raw: string): MultiFramePacket | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('TOSS1F|')) {
    if (trimmed.startsWith('TOSS1.')) {
      return {
        frameIndex: 1,
        totalFrames: 1,
        sessionId: 'single',
        chunk: trimmed,
        rawFrame: trimmed,
      };
    }
    return null;
  }
  const parts = trimmed.split('|');
  if (parts.length < 4) return null;
  const [, ratio, sessionId, ...rest] = parts;
  const chunk = rest.join('|');
  const [idxStr, totalStr] = ratio.split('/');
  const frameIndex = parseInt(idxStr, 10);
  const totalFrames = parseInt(totalStr, 10);
  if (!Number.isFinite(frameIndex) || !Number.isFinite(totalFrames) || frameIndex < 1 || totalFrames < 1 || frameIndex > totalFrames) {
    return null;
  }
  return {
    frameIndex,
    totalFrames,
    sessionId,
    chunk,
    rawFrame: trimmed,
  };
}

export function reassembleQrFrames(packets: MultiFramePacket[]): {
  complete: boolean;
  receivedCount: number;
  totalFrames: number;
  token: string | null;
} {
  if (packets.length === 0) {
    return { complete: false, receivedCount: 0, totalFrames: 0, token: null };
  }
  const totalFrames = packets[0].totalFrames;
  const targetSession = packets[0].sessionId;
  const map = new Map<number, string>();

  for (const pkt of packets) {
    if (pkt.sessionId === targetSession && pkt.totalFrames === totalFrames) {
      map.set(pkt.frameIndex, pkt.chunk);
    }
  }

  if (map.size < totalFrames) {
    return {
      complete: false,
      receivedCount: map.size,
      totalFrames,
      token: null,
    };
  }

  const ordered: string[] = [];
  for (let i = 1; i <= totalFrames; i++) {
    const piece = map.get(i);
    if (piece === undefined) {
      return { complete: false, receivedCount: map.size, totalFrames, token: null };
    }
    ordered.push(piece);
  }

  return {
    complete: true,
    receivedCount: totalFrames,
    totalFrames,
    token: ordered.join(''),
  };
}

export function serializeTossFile(payload: TossSignalPayloadV1, token: string): string {
  return JSON.stringify(
    {
      format: 'toss-signaling-file',
      version: 1,
      role: payload.type,
      sessionId: payload.sessionId,
      createdAt: payload.createdAt,
      token,
    },
    null,
    2
  );
}
