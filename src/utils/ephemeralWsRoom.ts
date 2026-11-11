/**
 * Ephemeral Browser-Saved WebSocket Room Transport
 *
 * Works 100% serverlessly on static hosts (Vercel `*.vercel.app`, Netlify, GitHub Pages)
 * AND local dev servers without spamming failed `wss://<host>/ws` requests.
 *
 * Architecture:
 * 1. Rooms are stored ONLY in the host browser tab (`sessionStorage`).
 * 2. Cross-device WebSocket streaming uses standard browser WebSockets over an
 *    ephemeral, zero-persistence pub/sub relay (`wss://broker.emqx.io:8084/mqtt`
 *    with failover to `wss://broker.hivemq.com:8884/mqtt`), plus local `/ws` ONLY
 *    when `/api/ws-health` confirms a local Node WebSocket server is running,
 *    plus `BroadcastChannel` for same-browser tabs.
 * 3. As soon as the host browser tab closes, the room is immediately destroyed
 *    via `beforeunload` / `pagehide` AND WebSocket Last-Will disconnect packets.
 */

export interface RoomMessage {
  type:
    | 'host_room'
    | 'join_room'
    | 'peer_join_request'
    | 'join_accepted'
    | 'photo_toss'
    | 'destroy_room'
    | 'room_destroyed'
    | 'room_error'
    | 'peer_left'
    | '_chunk';
  code: string;
  senderId?: string;
  timestamp?: number;
  reason?: string;
  message?: string;
  photo?: {
    id: string;
    title: string;
    dataUrl: string;
    timestamp: number;
  };
  // Internal chunking fields for large high-res photo payloads over WebSocket
  transferId?: string;
  index?: number;
  total?: number;
  data?: string;
}

const STATIC_HOST_SUFFIXES = [
  '.vercel.app',
  '.netlify.app',
  '.github.io',
  '.pages.dev',
  '.render.com',
  '.From-vercel',
  '.web.app',
  '.firebaseapp.com',
];

/**
 * Returns true if the current hostname is a static/serverless frontend host (like Vercel)
 * that does not run a persistent `/ws` server on the same origin.
 */
export function isStaticDeploymentHost(hostname: string): boolean {
  const lower = (hostname || '').toLowerCase().trim();
  if (!lower) return false;
  return STATIC_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Encodes variable-length remaining length per MQTT v3.1.1 spec.
 */
export function encodeMqttRemainingLength(length: number): number[] {
  const bytes: number[] = [];
  let x = length;
  do {
    let encodedByte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) {
      encodedByte = encodedByte | 128;
    }
    bytes.push(encodedByte);
  } while (x > 0);
  return bytes;
}

function encodeUtf8WithLength(str: string): Uint8Array {
  const utf8 = new TextEncoder().encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Builds an MQTT v3.1.1 CONNECT packet with optional Last Will and Testament (LWT)
 * so that if a host browser tab closes abruptly, the WebSocket broker automatically
 * broadcasts `room_destroyed` to the room topic.
 */
export function encodeMqttConnectPacket(
  clientId: string,
  willTopic?: string,
  willMessage?: string
): Uint8Array {
  // Variable header: Protocol Name "MQTT" (level 4), Connect Flags, Keep Alive (30s)
  const protoName = encodeUtf8WithLength('MQTT');
  const protoLevel = new Uint8Array([0x04]);
  // CleanSession = 1 (0x02). If willTopic provided: WillFlag = 1 (0x04)
  const hasWill = Boolean(willTopic && willMessage);
  const connectFlags = new Uint8Array([hasWill ? 0x06 : 0x02]);
  const keepAlive = new Uint8Array([0x00, 30]);

  const payloadParts: Uint8Array[] = [encodeUtf8WithLength(clientId)];
  if (hasWill && willTopic && willMessage) {
    payloadParts.push(encodeUtf8WithLength(willTopic));
    payloadParts.push(encodeUtf8WithLength(willMessage));
  }

  const body = concatUint8Arrays([
    protoName,
    protoLevel,
    connectFlags,
    keepAlive,
    ...payloadParts,
  ]);
  const remLen = encodeMqttRemainingLength(body.length);
  const header = new Uint8Array([0x10, ...remLen]);
  return concatUint8Arrays([header, body]);
}

/**
 * Builds an MQTT v3.1.1 SUBSCRIBE packet (QoS 0) for a given topic filter.
 */
export function encodeMqttSubscribePacket(packetId: number, topic: string): Uint8Array {
  const idBytes = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const topicBytes = encodeUtf8WithLength(topic);
  const qosByte = new Uint8Array([0x00]);
  const body = concatUint8Arrays([idBytes, topicBytes, qosByte]);
  const remLen = encodeMqttRemainingLength(body.length);
  const header = new Uint8Array([0x82, ...remLen]);
  return concatUint8Arrays([header, body]);
}

/**
 * Builds an MQTT v3.1.1 PUBLISH packet (QoS 0, Retain = 0 — strictly ephemeral, zero persistence).
 */
export function encodeMqttPublishPacket(topic: string, message: string): Uint8Array {
  const topicBytes = encodeUtf8WithLength(topic);
  const payloadBytes = new TextEncoder().encode(message);
  const body = concatUint8Arrays([topicBytes, payloadBytes]);
  const remLen = encodeMqttRemainingLength(body.length);
  const header = new Uint8Array([0x30, ...remLen]);
  return concatUint8Arrays([header, body]);
}

/**
 * Builds an MQTT v3.1.1 PINGREQ packet.
 */
export function encodeMqttPingReqPacket(): Uint8Array {
  return new Uint8Array([0xc0, 0x00]);
}

export interface DecodedMqttEvent {
  type: 'connack' | 'suback' | 'publish' | 'pingresp';
  topic?: string;
  payload?: string;
}

/**
 * Decodes one or more MQTT v3.1.1 frames from an incoming WebSocket binary buffer.
 */
export function decodeMqttPackets(buffer: Uint8Array): {
  events: DecodedMqttEvent[];
  remaining: Uint8Array;
} {
  const events: DecodedMqttEvent[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break;
    const firstByte = buffer[offset];
    const packetType = firstByte >> 4;

    // Decode variable-length remaining length
    let multiplier = 1;
    let remLength = 0;
    let lenCursor = offset + 1;
    let encodedByte = 0;
    let incompleteLength = false;

    do {
      if (lenCursor >= buffer.length) {
        incompleteLength = true;
        break;
      }
      encodedByte = buffer[lenCursor++];
      remLength += (encodedByte & 127) * multiplier;
      multiplier *= 128;
    } while ((encodedByte & 128) !== 0);

    if (incompleteLength) break;
    const packetEnd = lenCursor + remLength;
    if (packetEnd > buffer.length) break; // Wait for full frame

    const body = buffer.subarray(lenCursor, packetEnd);

    if (packetType === 2) {
      events.push({ type: 'connack' });
    } else if (packetType === 9) {
      events.push({ type: 'suback' });
    } else if (packetType === 13) {
      events.push({ type: 'pingresp' });
    } else if (packetType === 3 && body.length >= 2) {
      const topicLen = (body[0] << 8) | body[1];
      if (2 + topicLen <= body.length) {
        const topic = new TextDecoder().decode(body.subarray(2, 2 + topicLen));
        const qos = (firstByte >> 1) & 0x03;
        const payloadStart = 2 + topicLen + (qos > 0 ? 2 : 0);
        if (payloadStart <= body.length) {
          const payload = new TextDecoder().decode(body.subarray(payloadStart));
          events.push({ type: 'publish', topic, payload });
        }
      }
    }

    offset = packetEnd;
  }

  return {
    events,
    remaining: buffer.subarray(offset),
  };
}

const MAX_SINGLE_FRAME_CHARS = 24000;

/**
 * Splits a RoomMessage into one or more WebSocket-safe RoomMessage frames
 * so large high-resolution base64 photos never exceed public WebSocket frame limits.
 */
export function splitRoomMessageIntoFrames(msg: RoomMessage): RoomMessage[] {
  const serialized = JSON.stringify(msg);
  if (serialized.length <= MAX_SINGLE_FRAME_CHARS) {
    return [msg];
  }
  const transferId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const total = Math.ceil(serialized.length / MAX_SINGLE_FRAME_CHARS);
  const frames: RoomMessage[] = [];
  for (let i = 0; i < total; i++) {
    frames.push({
      type: '_chunk',
      code: msg.code,
      senderId: msg.senderId,
      transferId,
      index: i,
      total,
      data: serialized.slice(i * MAX_SINGLE_FRAME_CHARS, (i + 1) * MAX_SINGLE_FRAME_CHARS),
    });
  }
  return frames;
}

/**
 * Reassembles chunked `_chunk` frames back into the original RoomMessage.
 */
export class RoomChunkAssembler {
  private buffers = new Map<string, { total: number; parts: Map<number, string> }>();

  public push(msg: RoomMessage): RoomMessage | null {
    if (msg.type !== '_chunk') return msg;
    const { transferId, index, total, data } = msg;
    if (!transferId || typeof index !== 'number' || typeof total !== 'number' || typeof data !== 'string') {
      return null;
    }
    let entry = this.buffers.get(transferId);
    if (!entry) {
      entry = { total, parts: new Map() };
      this.buffers.set(transferId, entry);
    }
    entry.parts.set(index, data);
    if (entry.parts.size < entry.total) {
      return null;
    }
    // Reassemble in order
    let fullJson = '';
    for (let i = 0; i < entry.total; i++) {
      fullJson += entry.parts.get(i) || '';
    }
    this.buffers.delete(transferId);
    try {
      return JSON.parse(fullJson) as RoomMessage;
    } catch {
      return null;
    }
  }
}

const PUBLIC_WS_RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const TOPIC_PREFIX = 'toss/ephemeral/v1/room/';

function sendBinaryFrame(ws: WebSocket, bytes: Uint8Array): void {
  ws.send(bytes as unknown as BufferSource);
}

export class EphemeralRoomClient {
  private clientId: string;
  private onMessage: (msg: RoomMessage) => void;
  private onStatusChange: (connected: boolean) => void;
  private assembler = new RoomChunkAssembler();
  private seenMessageIds = new Set<string>();

  // Global WebSocket relay (works on Vercel, mobile LTE, and localhost)
  private mqttWs: WebSocket | null = null;
  private mqttConnected = false;
  private mqttRelayIndex = 0;
  private mqttRecvBuffer: Uint8Array = new Uint8Array(0);
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Optional local Node `/ws` socket (only opened if `/api/ws-health` confirms local server)
  private localWs: WebSocket | null = null;
  private localWsConnected = false;

  // Same-browser tab BroadcastChannel
  private bc: BroadcastChannel | null = null;

  private subscribedCodes = new Set<string>();
  private hostedCode: string | null = null;
  private destroyed = false;
  private joinTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    onMessage: (msg: RoomMessage) => void,
    onStatusChange: (connected: boolean) => void
  ) {
    this.clientId = `toss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  public start(): void {
    if (typeof window === 'undefined') return;

    // 1. Same-browser BroadcastChannel (instant zero-latency for tabs on the same device)
    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel('toss-ephemeral-ws-bridge');
      this.bc.onmessage = (ev) => {
        if (ev.data) {
          this.handleIncomingRawMessage(ev.data);
        }
      };
    }

    // 2. Connect global serverless WebSocket relay (works on Vercel `fileee-six.vercel.app` & mobile phones)
    this.connectGlobalMqttWs();

    // 3. Only probe local `/ws` if NOT on a static deployment host (like `.vercel.app`)
    if (!isStaticDeploymentHost(window.location.hostname)) {
      this.probeAndConnectLocalWs();
    }
  }

  private emitStatus(): void {
    this.onStatusChange(this.mqttConnected || this.localWsConnected);
  }

  private async probeAndConnectLocalWs(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch('/api/ws-health', {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('application/json')) {
        return; // Static host — never open `/ws` on origin
      }
      const data = await res.json();
      if (!data?.localWs || this.destroyed) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      this.localWs = ws;

      ws.onopen = () => {
        if (this.destroyed) {
          ws.close();
          return;
        }
        this.localWsConnected = true;
        this.emitStatus();
        if (this.hostedCode) {
          ws.send(JSON.stringify({ type: 'host_room', code: this.hostedCode, senderId: this.clientId }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          this.handleIncomingRawMessage(parsed);
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        this.localWsConnected = false;
        this.emitStatus();
      };
    } catch {
      // No local `/ws` server present (e.g. static deployment); rely cleanly on Global WebSocket Relay
    }
  }

  private connectGlobalMqttWs(): void {
    if (this.destroyed) return;
    const relayUrl = PUBLIC_WS_RELAYS[this.mqttRelayIndex % PUBLIC_WS_RELAYS.length];

    try {
      const ws = new WebSocket(relayUrl, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.mqttWs = ws;

      ws.onopen = () => {
        if (this.destroyed) {
          ws.close();
          return;
        }
        const willTopic = this.hostedCode ? `${TOPIC_PREFIX}${this.hostedCode}` : undefined;
        const willPayload = this.hostedCode
          ? JSON.stringify({
              type: 'room_destroyed',
              code: this.hostedCode,
              senderId: this.clientId,
              reason: 'Host browser tab closed — room was destroyed.',
              timestamp: Date.now(),
            })
          : undefined;

        sendBinaryFrame(ws, encodeMqttConnectPacket(this.clientId, willTopic, willPayload));
      };

      ws.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const incoming = new Uint8Array(event.data);
        const combined = new Uint8Array(this.mqttRecvBuffer.length + incoming.length);
        combined.set(this.mqttRecvBuffer, 0);
        combined.set(incoming, this.mqttRecvBuffer.length);

        const { events, remaining } = decodeMqttPackets(combined);
        this.mqttRecvBuffer = remaining;

        for (const ev of events) {
          if (ev.type === 'connack') {
            this.mqttConnected = true;
            this.emitStatus();
            // Subscribe to all active room topics
            for (const code of this.subscribedCodes) {
              this.sendMqttSubscribe(code);
            }
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
              if (this.mqttWs && this.mqttWs.readyState === WebSocket.OPEN) {
                sendBinaryFrame(this.mqttWs, encodeMqttPingReqPacket());
              }
            }, 20000);
          } else if (ev.type === 'publish' && ev.payload) {
            try {
              const parsed = JSON.parse(ev.payload) as RoomMessage;
              this.handleIncomingRawMessage(parsed);
            } catch {
              // Ignore invalid JSON
            }
          }
        }
      };

      ws.onclose = () => {
        this.mqttConnected = false;
        this.emitStatus();
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        if (!this.destroyed) {
          this.mqttRelayIndex = (this.mqttRelayIndex + 1) % PUBLIC_WS_RELAYS.length;
          this.reconnectTimeout = setTimeout(() => this.connectGlobalMqttWs(), 2500);
        }
      };
    } catch {
      // Fallback safely if WebSocket constructor throws
    }
  }

  private sendMqttSubscribe(code: string): void {
    if (!this.mqttWs || this.mqttWs.readyState !== WebSocket.OPEN || !this.mqttConnected) return;
    const packetId = Math.floor(Math.random() * 60000) + 1;
    sendBinaryFrame(this.mqttWs, encodeMqttSubscribePacket(packetId, `${TOPIC_PREFIX}${code}`));
  }

  private publishToMqttRoom(code: string, msg: RoomMessage): void {
    if (!this.mqttWs || this.mqttWs.readyState !== WebSocket.OPEN || !this.mqttConnected) return;
    const frames = splitRoomMessageIntoFrames(msg);
    const topic = `${TOPIC_PREFIX}${code}`;
    for (const frame of frames) {
      sendBinaryFrame(this.mqttWs, encodeMqttPublishPacket(topic, JSON.stringify(frame)));
    }
  }

  private handleIncomingRawMessage(rawMsg: RoomMessage): void {
    if (!rawMsg || typeof rawMsg !== 'object') return;
    // Ignore our own echoes from public pub/sub
    if (rawMsg.senderId && rawMsg.senderId === this.clientId) return;

    const assembled = this.assembler.push(rawMsg);
    if (!assembled) return;

    // Deduplicate identical messages arriving over multiple transports (e.g. BroadcastChannel + WebSocket)
    const dedupKey = `${assembled.type}:${assembled.code}:${assembled.timestamp || ''}:${assembled.photo?.id || ''}`;
    if (assembled.timestamp && this.seenMessageIds.has(dedupKey)) {
      return;
    }
    if (assembled.timestamp) {
      this.seenMessageIds.add(dedupKey);
      if (this.seenMessageIds.size > 200) {
        const first = this.seenMessageIds.values().next().value;
        if (first) this.seenMessageIds.delete(first);
      }
    }

    if (assembled.type === 'join_accepted') {
      if (this.joinTimeoutTimer) {
        clearTimeout(this.joinTimeoutTimer);
        this.joinTimeoutTimer = null;
      }
    }

    this.onMessage(assembled);
  }

  public hostRoom(code: string): void {
    const clean = code.trim();
    if (!clean) return;
    this.hostedCode = clean;
    this.subscribedCodes.add(clean);
    this.sendMqttSubscribe(clean);

    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(
        JSON.stringify({ type: 'host_room', code: clean, senderId: this.clientId, timestamp: Date.now() })
      );
    }
  }

  public joinRoom(code: string): void {
    const clean = code.trim();
    if (!clean) return;
    this.subscribedCodes.add(clean);
    this.sendMqttSubscribe(clean);

    const reqMsg: RoomMessage = {
      type: 'peer_join_request',
      code: clean,
      senderId: this.clientId,
      timestamp: Date.now(),
    };

    // Send over global WebSocket relay (plus retry once after 250ms to ensure subscription is active)
    this.publishToMqttRoom(clean, reqMsg);
    setTimeout(() => {
      if (!this.destroyed) {
        this.publishToMqttRoom(clean, { ...reqMsg, timestamp: Date.now() });
      }
    }, 250);

    // Send over local `/ws` if present
    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(
        JSON.stringify({ type: 'join_room', code: clean, senderId: this.clientId, timestamp: Date.now() })
      );
    }

    // Send over BroadcastChannel for same-browser tabs
    if (this.bc) {
      this.bc.postMessage(reqMsg);
    }

    // If no open host browser tab responds within 4 seconds, report room not found
    if (this.joinTimeoutTimer) clearTimeout(this.joinTimeoutTimer);
    this.joinTimeoutTimer = setTimeout(() => {
      this.onMessage({
        type: 'room_error',
        code: clean,
        message: `Room ${clean} not found or the host browser tab was closed.`,
      });
    }, 4000);
  }

  public sendRoomEvent(msg: Omit<RoomMessage, 'senderId' | 'timestamp'>): void {
    const fullMsg: RoomMessage = {
      ...msg,
      senderId: this.clientId,
      timestamp: Date.now(),
    };

    this.publishToMqttRoom(msg.code, fullMsg);

    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(JSON.stringify(fullMsg));
    }

    if (this.bc) {
      this.bc.postMessage(fullMsg);
    }
  }

  public destroyRoom(code: string): void {
    const clean = code.trim();
    if (!clean) return;

    const destroyMsg: RoomMessage = {
      type: 'room_destroyed',
      code: clean,
      senderId: this.clientId,
      reason: 'Host browser tab closed — room was destroyed.',
      timestamp: Date.now(),
    };

    this.publishToMqttRoom(clean, destroyMsg);

    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(
        JSON.stringify({
          type: 'destroy_room',
          code: clean,
          senderId: this.clientId,
          timestamp: Date.now(),
        })
      );
    }

    if (this.bc) {
      this.bc.postMessage(destroyMsg);
    }

    if (this.hostedCode === clean) {
      this.hostedCode = null;
    }
  }

  public stop(): void {
    this.destroyed = true;
    if (this.joinTimeoutTimer) clearTimeout(this.joinTimeoutTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.mqttWs) {
      try {
        this.mqttWs.close();
      } catch {}
    }
    if (this.localWs) {
      try {
        this.localWs.close();
      } catch {}
    }
    if (this.bc) {
      try {
        this.bc.close();
      } catch {}
    }
  }
}
