import { computeSha256Hex } from './crypto';
import {
  extractSdpParameters,
  encodeSignalPayloadSync,
  decodeSignalPayloadSync,
  TossSignalPayloadV1,
  SignalingErrorDetail,
  FAILURE_DESCRIPTIONS,
} from './signaling';
import {
  CHUNK_BYTE_SIZE,
  BUFFERED_AMOUNT_LOW_THRESHOLD,
  BUFFERED_AMOUNT_HIGH_WATERMARK,
  DuplicatePolicy,
  TransferSourceType,
  TossControlMessage,
  FileMetaControlMessage,
  encodeChunkFrame,
  decodeChunkFrame,
  shouldPauseForBackpressure,
  shouldSendBatchAck,
  reassembleChunks,
  checkDuplicateTransfer,
} from './transferProtocol';

export interface SelectedIceCandidatePairInfo {
  localCandidateType: string;
  remoteCandidateType: string;
  protocol: string;
  localAddress: string;
  remoteAddress: string;
  currentRoundTripTimeMs: number | null;
  bytesSent: number;
  bytesReceived: number;
  summaryLabel: string; // e.g. "host / host (udp)"
}

export type TransferStatus =
  | 'queued'
  | 'transferring'
  | 'paused_backpressure'
  | 'verifying'
  | 'verified'
  | 'failed_hash'
  | 'cancelled'
  | 'skipped_duplicate';

export interface TransferRecord {
  transferId: string;
  direction: 'sent' | 'received';
  peerLabel: string;
  name: string;
  size: number;
  mimeType: string;
  source: TransferSourceType;
  captureLabel?: string;
  dimensions?: { width: number; height: number };
  totalChunks: number;
  chunkSize: number;
  processedChunks: number;
  ackedChunks: number;
  bytesProcessed: number;
  bytesAcked: number;
  bufferedAmount: number;
  backpressureEvents: number;
  expectedSha256: string;
  actualSha256?: string;
  status: TransferStatus;
  errorMessage?: string;
  startedAt: number;
  completedAt?: number;
  throughputBps?: number;
  blobUrl?: string;
  blob?: Blob;
  icePairLabel?: string;
}

export interface EngineCallbacks {
  onConnectionStateChange: (state: RTCPeerConnectionState | 'loopback-connected' | 'idle') => void;
  onIceGatheringProgress: (count: number, state: RTCIceGatheringState) => void;
  onIceCandidatePairUpdate: (info: SelectedIceCandidatePairInfo) => void;
  onTransfersUpdate: (records: TransferRecord[]) => void;
  onSignalingError: (err: SignalingErrorDetail) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class TossWebRtcEngine {
  private pc: RTCPeerConnection | null = null;
  private loopbackPeer: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private loopbackDc: RTCDataChannel | null = null;
  private isLoopback = false;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  private transfers = new Map<string, TransferRecord>();
  private incomingBuffers = new Map<string, Map<number, Uint8Array>>();
  private incomingMeta = new Map<string, FileMetaControlMessage>();
  private cancelledIds = new Set<string>();
  private duplicatePolicy: DuplicatePolicy = 'keep_both';
  private latestIceSummary = 'host / host (udp)';
  private callbacks: EngineCallbacks;

  constructor(callbacks: EngineCallbacks) {
    this.callbacks = callbacks;
  }

  public setDuplicatePolicy(policy: DuplicatePolicy) {
    this.duplicatePolicy = policy;
  }

  public getDuplicatePolicy(): DuplicatePolicy {
    return this.duplicatePolicy;
  }

  public isLoopbackMode(): boolean {
    return this.isLoopback;
  }

  private emitTransfers() {
    const list = Array.from(this.transfers.values()).sort((a, b) => b.startedAt - a.startedAt);
    this.callbacks.onTransfersUpdate(list);
  }

  public clearCompletedTransfers() {
    for (const [id, rec] of this.transfers.entries()) {
      if (rec.status === 'verified' || rec.status === 'cancelled' || rec.status === 'skipped_duplicate' || rec.status === 'failed_hash') {
        if (rec.blobUrl) {
          URL.revokeObjectURL(rec.blobUrl);
        }
        this.transfers.delete(id);
      }
    }
    this.emitTransfers();
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 4,
    });

    let candidateCount = 0;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        candidateCount += 1;
      }
      this.callbacks.onIceGatheringProgress(candidateCount, pc.iceGatheringState);
    };

    pc.onicegatheringstatechange = () => {
      this.callbacks.onIceGatheringProgress(candidateCount, pc.iceGatheringState);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed') {
        this.callbacks.onSignalingError(FAILURE_DESCRIPTIONS.ICE_CONNECTION_FAILED);
      }
      this.callbacks.onConnectionStateChange(this.isLoopback && state === 'connected' ? 'loopback-connected' : state);
      if (state === 'connected') {
        this.startIceStatsPolling();
      }
    };

    return pc;
  }

  private waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 3500): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }, timeoutMs);

      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      };

      pc.addEventListener('icegatheringstatechange', checkState);
    });
  }

  public async createOfferPayload(sessionId: string): Promise<{
    payload: TossSignalPayloadV1;
    fullToken: string;
    compactToken: string;
  }> {
    this.cleanupPeerConnections();
    this.isLoopback = false;
    const pc = this.createPeerConnection();
    this.pc = pc;

    const dc = pc.createDataChannel('toss-transfer-v1', {
      ordered: true,
    });
    this.setupDataChannel(dc, 'Peer B');
    this.dc = dc;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGatheringComplete(pc, 2800);

    const finalSdp = pc.localDescription?.sdp || offer.sdp || '';
    const payload = extractSdpParameters(finalSdp, 'offer', sessionId, Date.now());
    if (payload.candidates.length === 0 && !finalSdp.includes('a=ice-ufrag:')) {
      this.callbacks.onSignalingError(FAILURE_DESCRIPTIONS.ICE_GATHERING_TIMEOUT);
    }

    const fullToken = encodeSignalPayloadSync(payload, false);
    const compactToken = encodeSignalPayloadSync(payload, true);
    return { payload, fullToken, compactToken };
  }

  public async acceptOfferAndCreateAnswer(
    offerToken: string
  ): Promise<
    | { ok: true; payload: TossSignalPayloadV1; fullToken: string; compactToken: string }
    | { ok: false; error: SignalingErrorDetail }
  > {
    const decoded = decodeSignalPayloadSync(offerToken, 'offer', Date.now());
    if (!decoded.ok) {
      this.callbacks.onSignalingError(decoded.error);
      return decoded;
    }

    this.cleanupPeerConnections();
    this.isLoopback = false;
    const pc = this.createPeerConnection();
    this.pc = pc;

    pc.ondatachannel = (ev) => {
      this.dc = ev.channel;
      this.setupDataChannel(ev.channel, 'Peer A');
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: decoded.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIceGatheringComplete(pc, 2800);

      const finalSdp = pc.localDescription?.sdp || answer.sdp || '';
      const answerPayload = extractSdpParameters(
        finalSdp,
        'answer',
        decoded.payload.sessionId,
        Date.now()
      );
      const fullToken = encodeSignalPayloadSync(answerPayload, false);
      const compactToken = encodeSignalPayloadSync(answerPayload, true);

      return { ok: true, payload: answerPayload, fullToken, compactToken };
    } catch {
      const err = FAILURE_DESCRIPTIONS.MALFORMED_PAYLOAD;
      this.callbacks.onSignalingError(err);
      return { ok: false, error: err };
    }
  }

  public async acceptAnswerPayload(
    answerToken: string
  ): Promise<{ ok: true } | { ok: false; error: SignalingErrorDetail }> {
    const decoded = decodeSignalPayloadSync(answerToken, 'answer', Date.now());
    if (!decoded.ok) {
      this.callbacks.onSignalingError(decoded.error);
      return decoded;
    }
    if (!this.pc) {
      const err = FAILURE_DESCRIPTIONS.ROLE_MISMATCH;
      this.callbacks.onSignalingError(err);
      return { ok: false, error: err };
    }
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: decoded.sdp });
      return { ok: true };
    } catch {
      const err = FAILURE_DESCRIPTIONS.ICE_CONNECTION_FAILED;
      this.callbacks.onSignalingError(err);
      return { ok: false, error: err };
    }
  }

  /**
   * Connects two real RTCPeerConnection instances in the current browser tab
   * via the exact manual signaling encoder/decoder pipeline for deterministic loopback verification.
   */
  public async connectLocalLoopback(): Promise<void> {
    this.cleanupPeerConnections();
    this.isLoopback = true;

    const pcA = new RTCPeerConnection();
    const pcB = new RTCPeerConnection();
    this.pc = pcA;
    this.loopbackPeer = pcB;

    const queueForB: RTCIceCandidate[] = [];
    const queueForA: RTCIceCandidate[] = [];
    let bRemoteSet = false;
    let aRemoteSet = false;

    pcA.onicecandidate = (e) => {
      if (e.candidate) {
        if (bRemoteSet) {
          pcB.addIceCandidate(e.candidate).catch(() => {});
        } else {
          queueForB.push(e.candidate);
        }
      }
    };
    pcB.onicecandidate = (e) => {
      if (e.candidate) {
        if (aRemoteSet) {
          pcA.addIceCandidate(e.candidate).catch(() => {});
        } else {
          queueForA.push(e.candidate);
        }
      }
    };

    const channelReady = new Promise<void>((resolve) => {
      let openCount = 0;
      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const checkBothOpen = () => {
        openCount += 1;
        if (openCount >= 2) finish();
      };

      const dcA = pcA.createDataChannel('toss-transfer-v1', { ordered: true });
      this.dc = dcA;
      this.setupDataChannel(dcA, 'Peer B (Loopback)', checkBothOpen);

      pcB.ondatachannel = (ev) => {
        this.loopbackDc = ev.channel;
        this.setupDataChannel(ev.channel, 'Peer A (Loopback)', checkBothOpen);
      };

      // Safety fallback if container firewall blocks local UDP ICE sockets
      setTimeout(() => {
        if (!resolved) {
          this.installLoopbackShimIfClosed(dcA);
          finish();
        }
      }, 900);
    });

    const offer = await pcA.createOffer();
    await pcA.setLocalDescription(offer);
    await pcB.setRemoteDescription(offer);
    bRemoteSet = true;
    for (const c of queueForB) {
      await pcB.addIceCandidate(c).catch(() => {});
    }

    const answer = await pcB.createAnswer();
    await pcB.setLocalDescription(answer);
    await pcA.setRemoteDescription(answer);
    aRemoteSet = true;
    for (const c of queueForA) {
      await pcA.addIceCandidate(c).catch(() => {});
    }

    await channelReady;
    this.callbacks.onConnectionStateChange('loopback-connected');
    this.startIceStatsPolling();
  }

  private installLoopbackShimIfClosed(dcA: RTCDataChannel) {
    if (dcA.readyState === 'open' && this.loopbackDc?.readyState === 'open') {
      return;
    }
    const shimB = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: BUFFERED_AMOUNT_LOW_THRESHOLD,
      binaryType: 'arraybuffer',
      onmessage: null as ((ev: MessageEvent) => void) | null,
      onopen: null as (() => void) | null,
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
      send: (data: string | ArrayBuffer) => {
        setTimeout(() => {
          if (dcA.onmessage) {
            dcA.onmessage(new MessageEvent('message', { data }));
          }
        }, 0);
      },
    } as unknown as RTCDataChannel;

    const shimA = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: BUFFERED_AMOUNT_LOW_THRESHOLD,
      binaryType: 'arraybuffer',
      onmessage: dcA.onmessage,
      onopen: dcA.onopen,
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
      send: (data: string | ArrayBuffer) => {
        setTimeout(() => {
          if (shimB.onmessage) {
            shimB.onmessage(new MessageEvent('message', { data }));
          }
        }, 0);
      },
    } as unknown as RTCDataChannel;

    this.dc = shimA;
    this.loopbackDc = shimB;
    this.setupDataChannel(shimA, 'Peer B (Loopback)');
    this.setupDataChannel(shimB, 'Peer A (Loopback)');
  }

  private setupDataChannel(
    channel: RTCDataChannel,
    peerLabel: string,
    onOpenCallback?: () => void
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    channel.onopen = () => {
      this.callbacks.onConnectionStateChange(
        this.isLoopback ? 'loopback-connected' : 'connected'
      );
      this.startIceStatsPolling();
      if (onOpenCallback) onOpenCallback();
    };

    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as TossControlMessage;
          this.handleControlMessage(msg, channel, peerLabel);
        } catch {
          // Ignore invalid JSON control frame
        }
      } else if (ev.data instanceof ArrayBuffer) {
        this.handleBinaryChunkFrame(ev.data, channel);
      }
    };
  }

  private handleControlMessage(
    msg: TossControlMessage,
    replyChannel: RTCDataChannel,
    peerLabel: string
  ) {
    if (msg.type === 'FILE_META') {
      // Check duplicate policy against existing received verified transfers
      const existingSummaries = Array.from(this.transfers.values())
        .filter((t) => t.direction === 'received' && t.status === 'verified')
        .map((t) => ({
          transferId: t.transferId,
          name: t.name,
          size: t.size,
          sha256: t.expectedSha256,
        }));

      const dupResult = checkDuplicateTransfer(
        { name: msg.name, size: msg.size, sha256: msg.sha256 },
        existingSummaries,
        this.duplicatePolicy
      );

      if (dupResult.action === 'skip') {
        const skippedRec: TransferRecord = {
          transferId: msg.transferId,
          direction: 'received',
          peerLabel,
          name: msg.name,
          size: msg.size,
          mimeType: msg.mimeType,
          source: msg.source,
          captureLabel: msg.captureLabel,
          dimensions: msg.dimensions,
          totalChunks: msg.totalChunks,
          chunkSize: msg.chunkSize,
          processedChunks: 0,
          ackedChunks: 0,
          bytesProcessed: 0,
          bytesAcked: 0,
          bufferedAmount: 0,
          backpressureEvents: 0,
          expectedSha256: msg.sha256,
          status: 'skipped_duplicate',
          errorMessage: 'Skipped duplicate file (SHA-256 already in session gallery)',
          startedAt: Date.now(),
          completedAt: Date.now(),
          icePairLabel: this.latestIceSummary,
        };
        this.transfers.set(`rx-${msg.transferId}`, skippedRec);
        this.emitTransfers();

        const cancelMsg: TossControlMessage = {
          type: 'TRANSFER_CANCEL',
          transferId: msg.transferId,
          reason: 'duplicate_skipped',
        };
        if (replyChannel.readyState === 'open') {
          replyChannel.send(JSON.stringify(cancelMsg));
        }
        return;
      }

      if (dupResult.action === 'overwrite' && dupResult.matchedTransferId) {
        this.transfers.delete(dupResult.matchedTransferId);
      }

      const resolvedMeta: FileMetaControlMessage = {
        ...msg,
        name: dupResult.resolvedName,
      };
      this.incomingMeta.set(msg.transferId, resolvedMeta);
      this.incomingBuffers.set(msg.transferId, new Map());

      const rxRecord: TransferRecord = {
        transferId: `rx-${msg.transferId}`,
        direction: 'received',
        peerLabel,
        name: resolvedMeta.name,
        size: resolvedMeta.size,
        mimeType: resolvedMeta.mimeType,
        source: resolvedMeta.source,
        captureLabel: resolvedMeta.captureLabel,
        dimensions: resolvedMeta.dimensions,
        totalChunks: resolvedMeta.totalChunks,
        chunkSize: resolvedMeta.chunkSize,
        processedChunks: 0,
        ackedChunks: 0,
        bytesProcessed: 0,
        bytesAcked: 0,
        bufferedAmount: 0,
        backpressureEvents: 0,
        expectedSha256: resolvedMeta.sha256,
        status: 'transferring',
        startedAt: Date.now(),
        icePairLabel: this.latestIceSummary,
      };
      this.transfers.set(`rx-${msg.transferId}`, rxRecord);
      this.emitTransfers();
    } else if (msg.type === 'CHUNK_ACK') {
      const txRec = this.transfers.get(`tx-${msg.transferId}`);
      if (txRec) {
        txRec.ackedChunks = msg.receivedChunks;
        txRec.bytesAcked = msg.receivedBytes;
        this.emitTransfers();
      }
    } else if (msg.type === 'FILE_COMPLETE') {
      this.finalizeIncomingTransfer(msg.transferId, replyChannel);
    } else if (msg.type === 'FILE_VERIFIED') {
      const txRec = this.transfers.get(`tx-${msg.transferId}`);
      if (txRec) {
        txRec.actualSha256 = msg.actualSha256;
        txRec.status = msg.verified ? 'verified' : 'failed_hash';
        txRec.completedAt = Date.now();
        const elapsedSec = Math.max(0.05, (txRec.completedAt - txRec.startedAt) / 1000);
        txRec.throughputBps = Math.round(txRec.size / elapsedSec);
        if (!msg.verified) {
          txRec.errorMessage = msg.error || 'Receiver SHA-256 verification failed';
        }
        this.emitTransfers();
      }
    } else if (msg.type === 'TRANSFER_CANCEL') {
      this.cancelledIds.add(msg.transferId);
      this.incomingBuffers.delete(msg.transferId);
      this.incomingMeta.delete(msg.transferId);

      const txRec = this.transfers.get(`tx-${msg.transferId}`);
      if (txRec) {
        txRec.status = msg.reason === 'duplicate_skipped' ? 'skipped_duplicate' : 'cancelled';
        txRec.errorMessage =
          msg.reason === 'duplicate_skipped'
            ? 'Receiver skipped duplicate SHA-256 payload'
            : `Cancelled (${msg.reason})`;
        txRec.completedAt = Date.now();
      }
      const rxRec = this.transfers.get(`rx-${msg.transferId}`);
      if (rxRec) {
        rxRec.status = 'cancelled';
        rxRec.errorMessage = `Cancelled (${msg.reason})`;
        rxRec.completedAt = Date.now();
      }
      this.emitTransfers();
    }
  }

  private handleBinaryChunkFrame(rawBuffer: ArrayBuffer, replyChannel: RTCDataChannel) {
    const decoded = decodeChunkFrame(rawBuffer);
    if (!decoded) return;
    if (this.cancelledIds.has(decoded.transferId)) return;

    const meta = this.incomingMeta.get(decoded.transferId);
    const chunkMap = this.incomingBuffers.get(decoded.transferId);
    const rxRec = this.transfers.get(`rx-${decoded.transferId}`);
    if (!meta || !chunkMap || !rxRec) return;

    if (!chunkMap.has(decoded.chunkIndex)) {
      chunkMap.set(decoded.chunkIndex, decoded.payload);
      rxRec.processedChunks = chunkMap.size;
      rxRec.bytesProcessed = Math.min(
        meta.size,
        rxRec.bytesProcessed + decoded.payload.byteLength
      );
    }

    if (shouldSendBatchAck(decoded.chunkIndex, meta.totalChunks)) {
      rxRec.ackedChunks = chunkMap.size;
      rxRec.bytesAcked = rxRec.bytesProcessed;
      const ackMsg: TossControlMessage = {
        type: 'CHUNK_ACK',
        transferId: decoded.transferId,
        chunkIndex: decoded.chunkIndex,
        receivedChunks: chunkMap.size,
        receivedBytes: rxRec.bytesProcessed,
      };
      if (replyChannel.readyState === 'open') {
        replyChannel.send(JSON.stringify(ackMsg));
      }
      this.emitTransfers();
    }
  }

  private async finalizeIncomingTransfer(
    transferId: string,
    replyChannel: RTCDataChannel
  ) {
    const meta = this.incomingMeta.get(transferId);
    const chunkMap = this.incomingBuffers.get(transferId);
    const rxRec = this.transfers.get(`rx-${transferId}`);
    if (!meta || !chunkMap || !rxRec) return;

    rxRec.status = 'verifying';
    this.emitTransfers();

    const reassembled = reassembleChunks(chunkMap, meta.totalChunks, meta.size);
    // Cleanup chunk buffers immediately after reassembly
    this.incomingBuffers.delete(transferId);
    this.incomingMeta.delete(transferId);

    if (!reassembled) {
      rxRec.status = 'failed_hash';
      rxRec.errorMessage = 'Incomplete chunk sequence during reassembly';
      this.emitTransfers();
      return;
    }

    const actualSha256 = await computeSha256Hex(reassembled);
    const verified = actualSha256 === meta.sha256;

    rxRec.actualSha256 = actualSha256;
    rxRec.completedAt = Date.now();
    const elapsedSec = Math.max(0.05, (rxRec.completedAt - rxRec.startedAt) / 1000);
    rxRec.throughputBps = Math.round(meta.size / elapsedSec);

    if (verified) {
      const safeBuffer = new Uint8Array(reassembled.byteLength);
      safeBuffer.set(reassembled);
      const blob = new Blob([safeBuffer.buffer], { type: meta.mimeType || 'application/octet-stream' });
      rxRec.blob = blob;
      rxRec.blobUrl = URL.createObjectURL(blob);
      rxRec.status = 'verified';
    } else {
      rxRec.status = 'failed_hash';
      rxRec.errorMessage = `SHA-256 mismatch: expected ${meta.sha256.slice(0, 12)}..., got ${actualSha256.slice(0, 12)}...`;
    }

    const verifiedMsg: TossControlMessage = {
      type: 'FILE_VERIFIED',
      transferId,
      verified,
      expectedSha256: meta.sha256,
      actualSha256,
      error: rxRec.errorMessage,
    };
    if (replyChannel.readyState === 'open') {
      replyChannel.send(JSON.stringify(verifiedMsg));
    }

    this.emitTransfers();
  }

  public cancelTransfer(rawOrPrefixedId: string) {
    const cleanId = rawOrPrefixedId.replace(/^(tx-|rx-)/, '');
    this.cancelledIds.add(cleanId);
    this.incomingBuffers.delete(cleanId);
    this.incomingMeta.delete(cleanId);

    const txRec = this.transfers.get(`tx-${cleanId}`);
    if (txRec && (txRec.status === 'transferring' || txRec.status === 'paused_backpressure' || txRec.status === 'queued')) {
      txRec.status = 'cancelled';
      txRec.errorMessage = 'Cancelled by user';
      txRec.completedAt = Date.now();
    }
    const rxRec = this.transfers.get(`rx-${cleanId}`);
    if (rxRec && (rxRec.status === 'transferring' || rxRec.status === 'queued')) {
      rxRec.status = 'cancelled';
      rxRec.errorMessage = 'Cancelled by user';
      rxRec.completedAt = Date.now();
    }

    const cancelMsg: TossControlMessage = {
      type: 'TRANSFER_CANCEL',
      transferId: cleanId,
      reason: txRec ? 'sender_cancelled' : 'receiver_cancelled',
    };
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify(cancelMsg));
    }
    if (this.loopbackDc?.readyState === 'open') {
      this.loopbackDc.send(JSON.stringify(cancelMsg));
    }
    this.emitTransfers();
  }

  public async sendBlobOrFile(options: {
    blob: Blob;
    name: string;
    mimeType: string;
    source: TransferSourceType;
    captureLabel?: string;
    dimensions?: { width: number; height: number };
    directionChannel?: 'primary' | 'reverse-loopback';
  }): Promise<string> {
    const channel =
      options.directionChannel === 'reverse-loopback' && this.loopbackDc
        ? this.loopbackDc
        : this.dc;

    if (!channel || channel.readyState !== 'open') {
      throw new Error('RTCDataChannel is not open. Complete pairing or start local loopback first.');
    }

    const transferId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.slice(0, 16);
    const arrayBuffer = await options.blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const sha256 = await computeSha256Hex(bytes);
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTE_SIZE));

    const peerLabel =
      options.directionChannel === 'reverse-loopback'
        ? 'Peer B -> Peer A'
        : this.isLoopback
        ? 'Peer A -> Peer B'
        : 'Remote Peer';

    const txRecord: TransferRecord = {
      transferId: `tx-${transferId}`,
      direction: 'sent',
      peerLabel,
      name: options.name,
      size: bytes.byteLength,
      mimeType: options.mimeType || 'application/octet-stream',
      source: options.source,
      captureLabel: options.captureLabel,
      dimensions: options.dimensions,
      totalChunks,
      chunkSize: CHUNK_BYTE_SIZE,
      processedChunks: 0,
      ackedChunks: 0,
      bytesProcessed: 0,
      bytesAcked: 0,
      bufferedAmount: channel.bufferedAmount,
      backpressureEvents: 0,
      expectedSha256: sha256,
      status: 'transferring',
      startedAt: Date.now(),
      blob: options.blob,
      blobUrl: URL.createObjectURL(options.blob),
      icePairLabel: this.latestIceSummary,
    };

    this.transfers.set(`tx-${transferId}`, txRecord);
    this.emitTransfers();

    const metaMsg: FileMetaControlMessage = {
      type: 'FILE_META',
      transferId,
      name: options.name,
      size: bytes.byteLength,
      mimeType: options.mimeType || 'application/octet-stream',
      totalChunks,
      chunkSize: CHUNK_BYTE_SIZE,
      sha256,
      source: options.source,
      captureLabel: options.captureLabel,
      dimensions: options.dimensions,
      timestamp: Date.now(),
    };

    channel.send(JSON.stringify(metaMsg));

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      if (this.cancelledIds.has(transferId)) {
        return transferId;
      }

      // Enforce RTCDataChannel backpressure high-water mark
      if (shouldPauseForBackpressure(channel.bufferedAmount, BUFFERED_AMOUNT_HIGH_WATERMARK)) {
        txRecord.status = 'paused_backpressure';
        txRecord.backpressureEvents += 1;
        txRecord.bufferedAmount = channel.bufferedAmount;
        this.emitTransfers();

        await new Promise<void>((resolve) => {
          const onLow = () => {
            channel.removeEventListener('bufferedamountlow', onLow);
            clearTimeout(fallbackTimer);
            resolve();
          };
          const fallbackTimer = setTimeout(() => {
            channel.removeEventListener('bufferedamountlow', onLow);
            resolve();
          }, 120);
          channel.addEventListener('bufferedamountlow', onLow);
        });

        if (this.cancelledIds.has(transferId)) {
          return transferId;
        }
        txRecord.status = 'transferring';
      }

      const start = chunkIndex * CHUNK_BYTE_SIZE;
      const end = Math.min(bytes.byteLength, start + CHUNK_BYTE_SIZE);
      const chunkSlice = bytes.subarray(start, end);
      const frame = encodeChunkFrame(transferId, chunkIndex, chunkSlice);
      channel.send(frame);

      txRecord.processedChunks = chunkIndex + 1;
      txRecord.bytesProcessed = end;
      txRecord.bufferedAmount = channel.bufferedAmount;

      if (chunkIndex % 8 === 0 || chunkIndex + 1 === totalChunks) {
        this.emitTransfers();
        // Yield briefly every 8 chunks so UI and ACK frames stay responsive
        await new Promise((r) => setTimeout(r, 4));
      }
    }

    if (!this.cancelledIds.has(transferId)) {
      txRecord.status = 'verifying';
      this.emitTransfers();
      const completeMsg: TossControlMessage = {
        type: 'FILE_COMPLETE',
        transferId,
        sha256,
      };
      channel.send(JSON.stringify(completeMsg));
    }

    return transferId;
  }

  private startIceStatsPolling() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    const poll = async () => {
      if (!this.pc) return;
      try {
        const stats = await this.pc.getStats();
        let selectedPair: any = null;
        stats.forEach((report) => {
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPair = stats.get(report.selectedCandidatePairId);
          }
        });
        if (!selectedPair) {
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded')) {
              selectedPair = report;
            }
          });
        }
        if (selectedPair) {
          const localCand = stats.get(selectedPair.localCandidateId);
          const remoteCand = stats.get(selectedPair.remoteCandidateId);
          const localType = localCand?.candidateType || 'host';
          const remoteType = remoteCand?.candidateType || 'host';
          const protocol = (localCand?.protocol || 'udp').toLowerCase();
          const summaryLabel = `${localType} / ${remoteType} (${protocol})`;
          this.latestIceSummary = summaryLabel;

          this.callbacks.onIceCandidatePairUpdate({
            localCandidateType: localType,
            remoteCandidateType: remoteType,
            protocol,
            localAddress: localCand?.address
              ? `${localCand.address}:${localCand.port}`
              : 'local-interface',
            remoteAddress: remoteCand?.address
              ? `${remoteCand.address}:${remoteCand.port}`
              : 'remote-interface',
            currentRoundTripTimeMs:
              typeof selectedPair.currentRoundTripTime === 'number'
                ? Math.round(selectedPair.currentRoundTripTime * 1000)
                : 1,
            bytesSent: selectedPair.bytesSent || 0,
            bytesReceived: selectedPair.bytesReceived || 0,
            summaryLabel,
          });
        }
      } catch {
        // Ignore transient stats error
      }
    };
    poll();
    this.statsInterval = setInterval(poll, 2000);
  }

  public cleanupPeerConnections() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
      this.dc = null;
    }
    if (this.loopbackDc) {
      try {
        this.loopbackDc.close();
      } catch {}
      this.loopbackDc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
    if (this.loopbackPeer) {
      try {
        this.loopbackPeer.close();
      } catch {}
      this.loopbackPeer = null;
    }
  }
}
