import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSha256HexSync, computeCrc32Hex, formatBytes } from './crypto';
import {
  extractSdpParameters,
  encodeSignalPayloadSync,
  decodeSignalPayloadSync,
  splitTokenIntoQrFrames,
  parseQrFrameString,
  reassembleQrFrames,
  SIGNAL_TTL_MS,
} from './signaling';
import {
  encodeChunkFrame,
  decodeChunkFrame,
  shouldPauseForBackpressure,
  shouldSendBatchAck,
  reassembleChunks,
  checkDuplicateTransfer,
  createDeterministicLoopbackPayload,
  CHUNK_BYTE_SIZE,
} from './transferProtocol';
import {
  createInitialGestureTracker,
  evaluatePinchHysteresis,
  stepGestureMachine,
  computePerspectiveTilt,
} from './gestureMachine';

test('SHA-256 sync matches NIST vector for "abc" and empty input', () => {
  const empty = computeSha256HexSync(new Uint8Array(0));
  assert.equal(empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  const abc = computeSha256HexSync(new TextEncoder().encode('abc'));
  assert.equal(abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(formatBytes(16384), '16.00 KiB');
});

test('Phase 2 signaling payload encodes, validates CRC32, and detects Section 5 failure states', () => {
  const sampleSdp = [
    'v=0',
    'o=- 12345 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:testUfrag',
    'a=ice-pwd:testPassword123456789012',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    'a=sctp-port:5000',
    'a=candidate:1 1 UDP 2122252543 192.168.1.10 54321 typ host',
    '',
  ].join('\r\n');

  const now = 1700000000000;
  const payload = extractSdpParameters(sampleSdp, 'offer', 'sess-01', now);
  const token = encodeSignalPayloadSync(payload, true);

  const decoded = decodeSignalPayloadSync(token, 'offer', now + 5000);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.payload.ufrag, 'testUfrag');
    assert.equal(decoded.payload.candidates.length, 1);
    assert.ok(decoded.sdp.includes('a=ice-ufrag:testUfrag'));
  }

  // Role mismatch: expecting answer but given offer
  const roleMismatch = decodeSignalPayloadSync(token, 'answer', now + 5000);
  assert.equal(roleMismatch.ok, false);
  if (!roleMismatch.ok) {
    assert.equal(roleMismatch.error.code, 'ROLE_MISMATCH');
  }

  // Expired payload (>10m)
  const expired = decodeSignalPayloadSync(token, 'offer', now + SIGNAL_TTL_MS + 1000);
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.error.code, 'EXPIRED_PAYLOAD');
  }

  // Corrupted payload checksum -> MALFORMED_PAYLOAD
  const corrupted = token.slice(0, -3) + 'XYZ';
  const malformed = decodeSignalPayloadSync(corrupted, 'offer', now + 1000);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.error.code, 'MALFORMED_PAYLOAD');
  }

  // Unsupported version -> UNSUPPORTED_VERSION
  const v2Token = token.replace('TOSS1.', 'TOSS2.');
  const unsupported = decodeSignalPayloadSync(v2Token, 'offer', now + 1000);
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) {
    assert.equal(unsupported.error.code, 'UNSUPPORTED_VERSION');
  }
});

test('Phase 2 multi-frame QR splitting and out-of-order reassembly', () => {
  const sampleToken = 'TOSS1.RAW.' + computeCrc32Hex('v1.abcd') + '.' + 'A'.repeat(550);
  const frames = splitTokenIntoQrFrames(sampleToken, 'sess-qr', 180);
  assert.equal(frames.length, 4);

  // Parse out of order: frame 3, frame 1, frame 4, frame 2
  const p3 = parseQrFrameString(frames[2].rawFrame)!;
  const p1 = parseQrFrameString(frames[0].rawFrame)!;
  const p4 = parseQrFrameString(frames[3].rawFrame)!;
  const p2 = parseQrFrameString(frames[1].rawFrame)!;

  const partial = reassembleQrFrames([p3, p1]);
  assert.equal(partial.complete, false);
  assert.equal(partial.receivedCount, 2);

  const full = reassembleQrFrames([p3, p1, p4, p2]);
  assert.equal(full.complete, true);
  assert.equal(full.token, sampleToken);
});

test('Phase 3 binary chunk framing, reassembly, backpressure, and duplicate detection', () => {
  const { bytes, sha256, totalChunks } = createDeterministicLoopbackPayload(40000);
  assert.equal(totalChunks, Math.ceil(40000 / CHUNK_BYTE_SIZE));

  const receivedMap = new Map<number, Uint8Array>();
  for (let i = 0; i < totalChunks; i++) {
    const slice = bytes.slice(i * CHUNK_BYTE_SIZE, (i + 1) * CHUNK_BYTE_SIZE);
    const frame = encodeChunkFrame('tx-test-001', i, slice);
    const decoded = decodeChunkFrame(frame);
    assert.ok(decoded);
    assert.equal(decoded.transferId, 'tx-test-001');
    assert.equal(decoded.chunkIndex, i);
    receivedMap.set(decoded.chunkIndex, decoded.payload);
  }

  const reassembled = reassembleChunks(receivedMap, totalChunks, bytes.byteLength);
  assert.ok(reassembled);
  assert.equal(computeSha256HexSync(reassembled), sha256);

  assert.equal(shouldPauseForBackpressure(100000), false);
  assert.equal(shouldPauseForBackpressure(300000), true);
  assert.equal(shouldSendBatchAck(7, 20), true);
  assert.equal(shouldSendBatchAck(2, 20), false);
  assert.equal(shouldSendBatchAck(19, 20), true);

  const dupSkip = checkDuplicateTransfer(
    { name: 'diagram.png', size: 40000, sha256 },
    [{ transferId: 'tx-1', name: 'diagram.png', size: 40000, sha256 }],
    'skip'
  );
  assert.equal(dupSkip.isDuplicate, true);
  assert.equal(dupSkip.action, 'skip');

  const dupKeep = checkDuplicateTransfer(
    { name: 'diagram.png', size: 40000, sha256 },
    [{ transferId: 'tx-1', name: 'diagram.png', size: 40000, sha256 }],
    'keep_both'
  );
  assert.equal(dupKeep.action, 'rename');
  assert.equal(dupKeep.resolvedName, 'diagram (copy-2).png');
});

test('Phase 4 & 6 pinch hysteresis and gesture velocity throw vs cancel spring-back', () => {
  // Pinch hysteresis
  assert.equal(evaluatePinchHysteresis(false, 0.060), false);
  assert.equal(evaluatePinchHysteresis(false, 0.045), true);
  // Remains pinched inside hysteresis band (0.045..0.075)
  assert.equal(evaluatePinchHysteresis(true, 0.065), true);
  // Exits pinch above exit threshold
  assert.equal(evaluatePinchHysteresis(true, 0.085), false);

  const region = { x: 0.25, y: 0.25, width: 0.4, height: 0.4 };
  let tracker = createInitialGestureTracker(region);

  // Hover inside region
  let res = stepGestureMachine(tracker, { x: 0.45, y: 0.45 }, false, region, 'right', 100);
  tracker = res.next;
  assert.equal(tracker.phase, 'HOVER');

  // Pinch grab inside region
  res = stepGestureMachine(tracker, { x: 0.45, y: 0.45 }, true, region, 'right', 116);
  tracker = res.next;
  assert.equal(tracker.phase, 'PINCH_GRAB');

  // Drag rapidly toward the right calibrated edge
  res = stepGestureMachine(tracker, { x: 0.65, y: 0.45 }, true, region, 'right', 132);
  tracker = res.next;
  assert.equal(tracker.phase, 'DRAG');

  res = stepGestureMachine(tracker, { x: 0.88, y: 0.45 }, true, region, 'right', 148);
  tracker = res.next;

  // Release pinch near right edge with positive rightward velocity -> triggers throw!
  res = stepGestureMachine(tracker, { x: 0.92, y: 0.45 }, false, region, 'right', 164);
  assert.equal(res.next.phase, 'RELEASE_THROW');
  assert.equal(res.triggeredThrow, true);

  // Reduced motion disables 3D perspective tilt
  const tiltReduced = computePerspectiveTilt({ x: 0.01, y: 0.01 }, { x: 0.2, y: 0.1 }, true);
  assert.equal(tiltReduced.rotateXDeg, 0);
  assert.equal(tiltReduced.rotateYDeg, 0);
  assert.equal(tiltReduced.scale, 1);
});

import {
  normalizeRoomCode,
  isHandInPhoneDeliveryZone,
  computeCinematicHandTransform,
} from './spatialToss';

test('Spatial 4-digit code normalization, phone zone delivery detection, and cinematic hand collapse', () => {
  assert.equal(normalizeRoomCode('48-299'), '4829');
  assert.equal(isHandInPhoneDeliveryZone({ x: 0.5, y: 0.5 }), false);
  assert.equal(isHandInPhoneDeliveryZone({ x: 0.85, y: 0.5 }), true);
  assert.equal(isHandInPhoneDeliveryZone({ x: 0.5, y: 0.10 }), true);

  const openTransform = computeCinematicHandTransform('PHOTO_OPEN', { x: 0.5, y: 0.5 }, { x: 0, y: 0 });
  assert.equal(openTransform.scale, 1);
  assert.equal(openTransform.opacity, 1);

  const heldTransform = computeCinematicHandTransform('HOLDING_IN_HAND', { x: 0.6, y: 0.4 }, { x: 0.001, y: -0.001 });
  assert.equal(heldTransform.scale, 0.22);
  assert.ok(heldTransform.rotateY > 0);

  const deliveredTransform = computeCinematicHandTransform('DELIVERED', { x: 0.9, y: 0.5 }, { x: 0, y: 0 });
  assert.equal(deliveredTransform.opacity, 0);
});

import {
  createInitialAnimeVfxState,
  createDimensionalShards,
  stepShardsTowardHand,
  generateLightningPoints,
  triggerAnimeGrabVfx,
  triggerAnimeLaunchVfx,
} from './animeVfxEngine';

test('Anime VFX Engine spawns dimensional shards, steps vortex absorption toward hand, and triggers impact frames', () => {
  const shards = createDimensionalShards(500, 400, 24);
  assert.equal(shards.length, 24);

  const stepped = stepShardsTowardHand(shards, 700, 300, 1);
  assert.equal(stepped.length, 24);
  assert.ok(stepped[0].progress > 0);

  const bolts = generateLightningPoints(100, 100, 300, 250, 8, 20, 0.5);
  assert.equal(bolts.length, 9);

  let state = createInitialAnimeVfxState();
  state = triggerAnimeGrabVfx(state, 600, 400, 720, 450);
  assert.equal(state.impactFramesRemaining, 3);
  assert.equal(state.shards.length, 36);
  assert.ok(state.rings.length >= 2);

  state = triggerAnimeLaunchVfx(state, 600, 400, 1380, 400);
  assert.equal(state.impactFramesRemaining, 4);
  assert.equal(state.beams.length, 1);
});

import {
  saveRoomInBrowserTab,
  loadRoomFromBrowserTab,
  destroyRoomInBrowserTab,
} from './spatialToss';

test('Browser-only room storage saves in tab storage and destroys cleanly on tab close', () => {
  const memoryStore = new Map<string, string>();
  const mockStorage = {
    setItem: (k: string, v: string) => memoryStore.set(k, v),
    getItem: (k: string) => memoryStore.get(k) ?? null,
    removeItem: (k: string) => memoryStore.delete(k),
  };

  saveRoomInBrowserTab(
    { code: '7391', role: 'creator', createdAt: 1700000000000, peerConnected: false },
    mockStorage
  );
  const loaded = loadRoomFromBrowserTab(mockStorage);
  assert.ok(loaded);
  assert.equal(loaded.code, '7391');
  assert.equal(loaded.role, 'creator');

  destroyRoomInBrowserTab(mockStorage);
  assert.equal(loadRoomFromBrowserTab(mockStorage), null);
});

import {
  isStaticDeploymentHost,
  encodeMqttConnectPacket,
  encodeMqttSubscribePacket,
  encodeMqttPublishPacket,
  decodeMqttPackets,
  splitRoomMessageIntoFrames,
  RoomChunkAssembler,
  RoomMessage,
} from './ephemeralWsRoom';

test('Serverless WebSocket room transport detects Vercel static host, encodes/decodes MQTT WebSocket frames, and chunks large photos', () => {
  assert.equal(isStaticDeploymentHost('fileee-six.vercel.app'), true);
  assert.equal(isStaticDeploymentHost('my-app.netlify.app'), true);
  assert.equal(isStaticDeploymentHost('localhost'), false);

  const connectPkt = encodeMqttConnectPacket('client_123', 'toss/ephemeral/v1/room/7204', '{"type":"room_destroyed"}');
  assert.equal(connectPkt[0], 0x10);

  const subPkt = encodeMqttSubscribePacket(42, 'toss/ephemeral/v1/room/7204');
  assert.equal(subPkt[0], 0x82);

  const pubPkt = encodeMqttPublishPacket(
    'toss/ephemeral/v1/room/7204',
    JSON.stringify({ type: 'join_accepted', code: '7204' })
  );
  const decoded = decodeMqttPackets(pubPkt);
  assert.equal(decoded.events.length, 1);
  assert.equal(decoded.events[0].type, 'publish');
  assert.equal(decoded.events[0].topic, 'toss/ephemeral/v1/room/7204');
  assert.deepEqual(JSON.parse(decoded.events[0].payload!), { type: 'join_accepted', code: '7204' });

  // Test large 80KB photo splitting and reassembly
  const largePhotoMsg: RoomMessage = {
    type: 'photo_toss',
    code: '7204',
    photo: {
      id: 'photo-1',
      title: 'Alpine.RAW',
      dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(80000),
      timestamp: 1700000000000,
    },
  };
  const frames = splitRoomMessageIntoFrames(largePhotoMsg);
  assert.ok(frames.length >= 4);
  assert.equal(frames[0].type, '_chunk');

  const assembler = new RoomChunkAssembler();
  let finalMsg: RoomMessage | null = null;
  for (const frame of frames) {
    finalMsg = assembler.push(frame);
  }
  assert.ok(finalMsg);
  assert.equal(finalMsg.type, 'photo_toss');
  assert.equal(finalMsg.photo?.dataUrl.length, largePhotoMsg.photo!.dataUrl.length);
});
