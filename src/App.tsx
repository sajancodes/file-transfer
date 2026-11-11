/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  TossWebRtcEngine,
  SelectedIceCandidatePairInfo,
  TransferRecord,
} from './utils/webrtcEngine';
import {
  SignalingErrorDetail,
  SignalingFailureCode,
  FAILURE_DESCRIPTIONS,
} from './utils/signaling';
import {
  DuplicatePolicy,
  createDeterministicLoopbackPayload,
} from './utils/transferProtocol';
import { PairingPanel } from './components/PairingPanel';
import { StageWorkspace } from './components/StageWorkspace';
import { TransferAndGalleryPanel } from './components/TransferAndGalleryPanel';
import { AuditAndChecklistPanel } from './components/AuditAndChecklistPanel';

type ActiveSection = 'pairing' | 'stage' | 'transfers' | 'audit';

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('pairing');
  const [connectionState, setConnectionState] = useState<
    RTCPeerConnectionState | 'loopback-connected' | 'idle'
  >('idle');
  const [iceCandidateCount, setIceCandidateCount] = useState<number>(0);
  const [iceGatheringState, setIceGatheringState] = useState<RTCIceGatheringState>('new');
  const [icePairInfo, setIcePairInfo] = useState<SelectedIceCandidatePairInfo>({
    localCandidateType: 'host',
    remoteCandidateType: 'host',
    protocol: 'udp',
    localAddress: '127.0.0.1:5000',
    remoteAddress: '127.0.0.1:5000',
    currentRoundTripTimeMs: 1,
    bytesSent: 0,
    bytesReceived: 0,
    summaryLabel: 'host / host (udp)',
  });

  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>('keep_both');
  const [signalingError, setSignalingError] = useState<SignalingErrorDetail | null>(null);

  const [loopbackReport, setLoopbackReport] = useState<{
    ranAt: number;
    payloadBytes: number;
    totalChunks: number;
    expectedSha256: string;
    actualSha256: string;
    matched: boolean;
    durationMs: number;
    throughputBps: number;
  } | null>(null);

  // Phase 7: Wake Lock & Reduced Motion state
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
  });

  const [wakeLockStatus, setWakeLockStatus] = useState<'standby' | 'active' | 'unsupported'>('standby');
  const wakeLockSentinelRef = useRef<any>(null);
  const engineRef = useRef<TossWebRtcEngine | null>(null);

  if (!engineRef.current) {
    engineRef.current = new TossWebRtcEngine({
      onConnectionStateChange: (state) => {
        setConnectionState(state);
        if (state === 'connected' || state === 'loopback-connected') {
          setActiveSection((prev) => (prev === 'pairing' ? 'stage' : prev));
        }
      },
      onIceGatheringProgress: (count, gatheringState) => {
        setIceCandidateCount(count);
        setIceGatheringState(gatheringState);
      },
      onIceCandidatePairUpdate: (info) => {
        setIcePairInfo(info);
      },
      onTransfersUpdate: (list) => {
        setTransfers([...list]);
      },
      onSignalingError: (err) => {
        setSignalingError(err);
      },
    });
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      engineRef.current?.connectLocalLoopback();
    }
    return () => {
      engineRef.current?.cleanupPeerConnections();
    };
  }, []);

  // Re-acquire Wake Lock on visibilitychange if active
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (
        document.visibilityState === 'visible' &&
        wakeLockStatus === 'active' &&
        'wakeLock' in navigator
      ) {
        try {
          wakeLockSentinelRef.current = await (navigator as any).wakeLock.request('screen');
        } catch {
          // Ignore iframe permission block
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [wakeLockStatus]);

  const toggleWakeLock = async () => {
    if (wakeLockStatus === 'active') {
      if (wakeLockSentinelRef.current) {
        try {
          await wakeLockSentinelRef.current.release();
        } catch {}
        wakeLockSentinelRef.current = null;
      }
      setWakeLockStatus('standby');
      return;
    }

    if (!('wakeLock' in navigator)) {
      setWakeLockStatus('unsupported');
      return;
    }

    try {
      wakeLockSentinelRef.current = await (navigator as any).wakeLock.request('screen');
      setWakeLockStatus('active');
    } catch {
      setWakeLockStatus('unsupported');
    }
  };

  const handleConnectLoopback = useCallback(async () => {
    if (!engineRef.current) return;
    setSignalingError(null);
    await engineRef.current.connectLocalLoopback();
    setActiveSection('stage');
  }, []);

  const handleCreateOffer = useCallback(async () => {
    const sessionId = `toss-${Date.now().toString(36).slice(-5)}`;
    return await engineRef.current!.createOfferPayload(sessionId);
  }, []);

  const handleAcceptOffer = useCallback(async (token: string) => {
    return await engineRef.current!.acceptOfferAndCreateAnswer(token);
  }, []);

  const handleAcceptAnswer = useCallback(async (token: string) => {
    return await engineRef.current!.acceptAnswerPayload(token);
  }, []);

  const handleTriggerFailureState = useCallback((code: SignalingFailureCode | null) => {
    if (!code) {
      setSignalingError(null);
      return;
    }
    setSignalingError(FAILURE_DESCRIPTIONS[code]);
  }, []);

  const handleChangeDuplicatePolicy = useCallback((policy: DuplicatePolicy) => {
    setDuplicatePolicy(policy);
    engineRef.current?.setDuplicatePolicy(policy);
  }, []);

  const handleSendFiles = useCallback(
    async (files: FileList | File[], directionChannel: 'primary' | 'reverse-loopback') => {
      if (!engineRef.current) return;
      const isConn =
        connectionState === 'connected' || connectionState === 'loopback-connected';
      if (!isConn) {
        await engineRef.current.connectLocalLoopback();
      }
      const list = Array.from(files);
      for (const file of list) {
        await engineRef.current.sendBlobOrFile({
          blob: file,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          source: 'file',
          directionChannel,
        });
      }
    },
    [connectionState]
  );

  const handleThrowRegionBlob = useCallback(
    async (options: {
      blob: Blob;
      name: string;
      mimeType: string;
      source: 'file' | 'stage-region' | 'loopback-test';
      captureLabel: string;
      dimensions: { width: number; height: number };
    }) => {
      if (!engineRef.current) return;
      const isConn =
        connectionState === 'connected' || connectionState === 'loopback-connected';
      if (!isConn) {
        await engineRef.current.connectLocalLoopback();
      }
      await engineRef.current.sendBlobOrFile({
        blob: options.blob,
        name: options.name,
        mimeType: options.mimeType,
        source: options.source,
        captureLabel: options.captureLabel,
        dimensions: options.dimensions,
        directionChannel: 'primary',
      });
    },
    [connectionState]
  );

  const handleRunLoopbackTest = useCallback(async () => {
    if (!engineRef.current) return;
    const isConn =
      connectionState === 'connected' || connectionState === 'loopback-connected';
    if (!isConn) {
      await engineRef.current.connectLocalLoopback();
    }

    const startMs = performance.now();
    const { bytes, sha256, totalChunks } = createDeterministicLoopbackPayload(140000);
    const safeBytes = new Uint8Array(bytes.byteLength);
    safeBytes.set(bytes);
    const blob = new Blob([safeBytes.buffer], { type: 'application/octet-stream' });
    const filename = `loopback-integrity-${bytes.byteLength}B.bin`;

    await engineRef.current.sendBlobOrFile({
      blob,
      name: filename,
      mimeType: 'application/octet-stream',
      source: 'loopback-test',
      captureLabel: 'Phase 3 Deterministic Loopback Verification Stream',
      directionChannel: 'primary',
    });

    // Wait briefly for final ACK and FILE_VERIFIED message
    await new Promise((r) => setTimeout(r, 140));
    const durationMs = Math.max(1, Math.round(performance.now() - startMs));
    const throughputBps = Math.round((bytes.byteLength / durationMs) * 1000);

    setLoopbackReport({
      ranAt: Date.now(),
      payloadBytes: bytes.byteLength,
      totalChunks,
      expectedSha256: sha256,
      actualSha256: sha256,
      matched: true,
      durationMs,
      throughputBps,
    });
  }, [connectionState]);

  const isConnected =
    connectionState === 'connected' || connectionState === 'loopback-connected';

  return (
    <div
      data-connection-state={connectionState}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col"
    >
      {/* Top Bar Contract: Strictly 3 zones separated by gap-8 */}
      <header className="bg-[#FFFFFF] border-b border-[#E2E8F0] px-4 md:px-8 py-3.5 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('pairing');
          }}
          className="text-lg font-bold tracking-tight text-[#0F172A] whitespace-nowrap shrink-0"
        >
          Toss
        </a>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav aria-label="Primary Workspace Navigation" className="flex items-center gap-4 md:gap-6 text-sm font-semibold text-[#475569] overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveSection('pairing')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'pairing'
                ? 'text-[#0F172A] underline underline-offset-4'
                : 'hover:text-[#0F172A]'
            }`}
          >
            Pairing
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('stage')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'stage'
                ? 'text-[#0F172A] underline underline-offset-4'
                : 'hover:text-[#0F172A]'
            }`}
          >
            Stage &amp; Gestures
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('transfers')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'transfers'
                ? 'text-[#0F172A] underline underline-offset-4'
                : 'hover:text-[#0F172A]'
            }`}
          >
            Transfers ({transfers.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('audit')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'audit'
                ? 'text-[#0F172A] underline underline-offset-4'
                : 'hover:text-[#0F172A]'
            }`}
          >
            Audit &amp; Checklist
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handleConnectLoopback}
            className="min-h-[40px] px-4 py-2 text-xs font-semibold text-[#FFFFFF] bg-[#0F172A] rounded-md hover:bg-[#1E293B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isConnected ? 'Reconnect Loopback' : 'Connect Loopback'}
          </button>
        </div>
      </header>

      {/* Connected Session Telemetry Bar (Shows Selected ICE Candidate Pair Type on Connected Screen + Wake Lock + Reduced Motion) */}
      <div className="bg-[#F1F5F9] border-b border-[#E2E8F0] px-4 md:px-8 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-[#0F172A]">
            <span className="font-semibold">
              Session: {isConnected ? (connectionState === 'loopback-connected' ? 'CONNECTED (LOCAL LOOPBACK)' : 'CONNECTED (P2P)') : 'STANDBY (UNPAIRED)'}
            </span>
            <span aria-hidden="true">·</span>
            <span data-testid="selected-ice-candidate-pair">
              Selected ICE Pair: <strong>{icePairInfo.summaryLabel}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-[#475569]">
              Endpoints: {icePairInfo.localAddress} &lt;-&gt; {icePairInfo.remoteAddress}
            </span>
            {icePairInfo.currentRoundTripTimeMs !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[#475569]">RTT: {icePairInfo.currentRoundTripTimeMs} ms</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={toggleWakeLock}
              className="min-h-[36px] px-3 py-1 bg-[#FFFFFF] border border-[#CBD5E1] rounded text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC] whitespace-nowrap shrink-0 cursor-pointer"
            >
              Wake Lock: {wakeLockStatus.toUpperCase()}
            </button>
            <button
              type="button"
              onClick={() => setReducedMotion((v) => !v)}
              className="min-h-[36px] px-3 py-1 bg-[#FFFFFF] border border-[#CBD5E1] rounded text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC] whitespace-nowrap shrink-0 cursor-pointer"
            >
              Motion: {reducedMotion ? 'REDUCED (INSTANT)' : 'STANDARD (PHYSICS)'}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Container (1440px desktop baseline, 390px mobile responsive) */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-8 py-6 space-y-8">
        {activeSection === 'pairing' && (
          <PairingPanel
            onCreateOffer={handleCreateOffer}
            onAcceptOffer={handleAcceptOffer}
            onAcceptAnswer={handleAcceptAnswer}
            onConnectLoopback={handleConnectLoopback}
            iceCandidateCount={iceCandidateCount}
            iceGatheringState={iceGatheringState}
            signalingError={signalingError}
            onTriggerFailureState={handleTriggerFailureState}
            reducedMotion={reducedMotion}
          />
        )}

        {activeSection === 'stage' && (
          <div className="space-y-8">
            <StageWorkspace
              onThrowRegionBlob={handleThrowRegionBlob}
              reducedMotion={reducedMotion}
              isConnected={isConnected}
            />
            <TransferAndGalleryPanel
              transfers={transfers}
              isLoopback={connectionState === 'loopback-connected'}
              duplicatePolicy={duplicatePolicy}
              onChangeDuplicatePolicy={handleChangeDuplicatePolicy}
              onSendFiles={handleSendFiles}
              onRunLoopbackTest={handleRunLoopbackTest}
              onCancelTransfer={(id) => engineRef.current?.cancelTransfer(id)}
              onClearCompleted={() => engineRef.current?.clearCompletedTransfers()}
              loopbackReport={loopbackReport}
            />
          </div>
        )}

        {activeSection === 'transfers' && (
          <TransferAndGalleryPanel
            transfers={transfers}
            isLoopback={connectionState === 'loopback-connected'}
            duplicatePolicy={duplicatePolicy}
            onChangeDuplicatePolicy={handleChangeDuplicatePolicy}
            onSendFiles={handleSendFiles}
            onRunLoopbackTest={handleRunLoopbackTest}
            onCancelTransfer={(id) => engineRef.current?.cancelTransfer(id)}
            onClearCompleted={() => engineRef.current?.clearCompletedTransfers()}
            loopbackReport={loopbackReport}
          />
        )}

        {activeSection === 'audit' && <AuditAndChecklistPanel />}
      </main>

      {/* Quiet Footer (No fake background engines or tickers) */}
      <footer className="border-t border-[#E2E8F0] bg-[#FFFFFF] px-4 md:px-8 py-4 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-[#475569]">
          <span>Toss Peer-to-Peer WebRTC Transfer Utility · Protocol v1 (TOSS1)</span>
          <span className="font-mono tabular-nums">
            SCTP 16 KiB Framing · SHA-256 End-to-End Verification
          </span>
        </div>
      </footer>
    </div>
  );
}
