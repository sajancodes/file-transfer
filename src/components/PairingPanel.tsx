import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import {
  TossSignalPayloadV1,
  SignalingErrorDetail,
  SignalingFailureCode,
  FAILURE_DESCRIPTIONS,
  splitTokenIntoQrFrames,
  parseQrFrameString,
  reassembleQrFrames,
  serializeTossFile,
  MultiFramePacket,
} from '../utils/signaling';
import { formatBytes } from '../utils/crypto';

interface PairingPanelProps {
  onCreateOffer: () => Promise<{
    payload: TossSignalPayloadV1;
    fullToken: string;
    compactToken: string;
  }>;
  onAcceptOffer: (token: string) => Promise<
    | { ok: true; payload: TossSignalPayloadV1; fullToken: string; compactToken: string }
    | { ok: false; error: SignalingErrorDetail }
  >;
  onAcceptAnswer: (token: string) => Promise<{ ok: true } | { ok: false; error: SignalingErrorDetail }>;
  onConnectLoopback: () => Promise<void>;
  iceCandidateCount: number;
  iceGatheringState: RTCIceGatheringState;
  signalingError: SignalingErrorDetail | null;
  onTriggerFailureState: (code: SignalingFailureCode | null) => void;
  reducedMotion: boolean;
}

export const PairingPanel: React.FC<PairingPanelProps> = ({
  onCreateOffer,
  onAcceptOffer,
  onAcceptAnswer,
  onConnectLoopback,
  iceCandidateCount,
  iceGatheringState,
  signalingError,
  onTriggerFailureState,
  reducedMotion,
}) => {
  const [roleTab, setRoleTab] = useState<'initiator' | 'responder'>('initiator');
  const [busy, setBusy] = useState(false);

  const [localPayload, setLocalPayload] = useState<TossSignalPayloadV1 | null>(null);
  const [localToken, setLocalToken] = useState<string>('');
  const [compactToken, setCompactToken] = useState<string>('');

  const [qrMode, setQrMode] = useState<'single' | 'multi'>('single');
  const [activeFrameIdx, setActiveFrameIdx] = useState(0);
  const [autoCycleQr, setAutoCycleQr] = useState(true);
  const [qrSvgMarkup, setQrSvgMarkup] = useState<string>('');

  const [remoteInput, setRemoteInput] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [assembledPackets, setAssembledPackets] = useState<MultiFramePacket[]>([]);
  const [frameInputText, setFrameInputText] = useState('');

  // Optional Camera QR Scanner
  const [scannerActive, setScannerActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const frames = React.useMemo(() => {
    const source = qrMode === 'single' ? compactToken : localToken;
    if (!source || !localPayload) return [];
    if (qrMode === 'single') {
      return [
        {
          frameIndex: 1,
          totalFrames: 1,
          sessionId: localPayload.sessionId,
          chunk: source,
          rawFrame: source,
        },
      ];
    }
    return splitTokenIntoQrFrames(source, localPayload.sessionId, 160);
  }, [qrMode, compactToken, localToken, localPayload]);

  useEffect(() => {
    setActiveFrameIdx(0);
  }, [qrMode, localToken]);

  useEffect(() => {
    if (qrMode !== 'multi' || frames.length <= 1 || !autoCycleQr || reducedMotion) {
      return;
    }
    const timer = setInterval(() => {
      setActiveFrameIdx((prev) => (prev + 1) % frames.length);
    }, 650);
    return () => clearInterval(timer);
  }, [qrMode, frames.length, autoCycleQr, reducedMotion]);

  useEffect(() => {
    const currentPacket = frames[activeFrameIdx] || frames[0];
    if (!currentPacket) {
      setQrSvgMarkup('');
      return;
    }
    let cancelled = false;
    QRCode.toString(currentPacket.rawFrame, {
      type: 'svg',
      errorCorrectionLevel: 'L',
      margin: 2,
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
    })
      .then((svg) => {
        if (!cancelled) setQrSvgMarkup(svg);
      })
      .catch(() => {
        if (!cancelled) setQrSvgMarkup('');
      });
    return () => {
      cancelled = true;
    };
  }, [frames, activeFrameIdx]);

  useEffect(() => {
    return () => {
      stopCameraScanner();
    };
  }, []);

  const stopCameraScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setScannerActive(false);
  };

  const startCameraScanner = async () => {
    onTriggerFailureState(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      onTriggerFailureState('CAMERA_PERMISSION_DENIED');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      setScannerActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      onTriggerFailureState('CAMERA_PERMISSION_DENIED');
      setScannerActive(false);
    }
  };

  const handleGenerateOffer = async () => {
    setBusy(true);
    onTriggerFailureState(null);
    try {
      const res = await onCreateOffer();
      setLocalPayload(res.payload);
      setLocalToken(res.fullToken);
      setCompactToken(res.compactToken);
    } finally {
      setBusy(false);
    }
  };

  const handleProcessRemoteInput = async (tokenOverride?: string) => {
    const raw = (tokenOverride ?? remoteInput).trim();
    if (!raw) {
      onTriggerFailureState('MALFORMED_PAYLOAD');
      return;
    }
    setBusy(true);
    try {
      if (roleTab === 'responder') {
        const res = await onAcceptOffer(raw);
        if (res.ok) {
          setLocalPayload(res.payload);
          setLocalToken(res.fullToken);
          setCompactToken(res.compactToken);
        }
      } else {
        await onAcceptAnswer(raw);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToken = async () => {
    if (!localToken) return;
    try {
      await navigator.clipboard.writeText(localToken);
      setCopyFeedback('Copied TOSS1 token');
    } catch {
      setCopyFeedback('Token selected');
    }
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  const handleExportTossFile = () => {
    if (!localPayload || !localToken) return;
    const content = serializeTossFile(localPayload, localToken);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${localPayload.sessionId}-${localPayload.type}.toss`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportTossFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRemoteInput(text);
    await handleProcessRemoteInput(text);
    e.target.value = '';
  };

  const handleIngestQrFrame = (rawFrameStr: string) => {
    const pkt = parseQrFrameString(rawFrameStr);
    if (!pkt) {
      onTriggerFailureState('MALFORMED_PAYLOAD');
      return;
    }
    const nextList = [...assembledPackets.filter((p) => p.frameIndex !== pkt.frameIndex), pkt];
    setAssembledPackets(nextList);
    const reassembled = reassembleQrFrames(nextList);
    if (reassembled.complete && reassembled.token) {
      setRemoteInput(reassembled.token);
    }
  };

  const handleLoadCurrentQrFramesIntoAssembler = () => {
    if (frames.length === 0) return;
    setAssembledPackets(frames);
    const reassembled = reassembleQrFrames(frames);
    if (reassembled.complete && reassembled.token) {
      setRemoteInput(reassembled.token);
    }
  };

  const assemblyStatus = reassembleQrFrames(assembledPackets);

  return (
    <section aria-labelledby="pairing-heading" className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-[#E2E8F0] pb-4">
        <div>
          <h1 id="pairing-heading" className="text-2xl md:text-3xl font-bold tracking-tight text-[#0F172A]">
            Manual Signaling & Peer Pairing
          </h1>
          <p className="text-sm md:text-base text-[#475569] mt-1">
            Establish a direct WebRTC DataChannel using versioned TOSS1 payloads, QR frames, or .toss files without a signaling server.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onConnectLoopback}
            disabled={busy}
            className="min-h-[44px] px-4 py-2 bg-[#0F172A] text-[#FFFFFF] text-sm font-semibold rounded-md hover:bg-[#1E293B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F172A] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Connect Local Loopback
          </button>
        </div>
      </div>

      {/* Section 5 Signaling Failure State Alert Banner */}
      {signalingError && (
        <div
          role="alert"
          aria-live="assertive"
          className="bg-[#FFFFFF] border border-[#DC2626] rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-mono text-[#DC2626] tabular-nums">
              <span className="font-semibold">{signalingError.code}</span>
              <span aria-hidden="true">·</span>
              <span>Section 5 Signaling Diagnostic</span>
            </div>
            <h2 className="text-base font-semibold text-[#0F172A]">{signalingError.title}</h2>
            <p className="text-sm text-[#475569]">{signalingError.detail}</p>
            <p className="text-xs font-semibold text-[#0F172A]">Recovery: {signalingError.recovery}</p>
          </div>
          <button
            type="button"
            onClick={() => onTriggerFailureState(null)}
            className="min-h-[44px] px-4 py-2 border border-[#CBD5E1] bg-[#F8FAFC] text-[#0F172A] text-xs font-semibold rounded-md hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 self-start md:self-center cursor-pointer"
          >
            Dismiss Diagnostic
          </button>
        </div>
      )}

      {/* Role Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div role="tablist" aria-label="Signaling Role" className="inline-flex p-1 bg-[#F1F5F9] border border-[#E2E8F0] rounded-md">
          <button
            role="tab"
            type="button"
            aria-selected={roleTab === 'initiator'}
            onClick={() => {
              setRoleTab('initiator');
              onTriggerFailureState(null);
            }}
            className={`min-h-[40px] px-4 py-2 text-sm font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              roleTab === 'initiator'
                ? 'bg-[#FFFFFF] text-[#0F172A] border border-[#CBD5E1]'
                : 'text-[#475569] hover:text-[#0F172A]'
            }`}
          >
            01. Initiator (Create Offer)
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={roleTab === 'responder'}
            onClick={() => {
              setRoleTab('responder');
              onTriggerFailureState(null);
            }}
            className={`min-h-[40px] px-4 py-2 text-sm font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              roleTab === 'responder'
                ? 'bg-[#FFFFFF] text-[#0F172A] border border-[#CBD5E1]'
                : 'text-[#475569] hover:text-[#0F172A]'
            }`}
          >
            02. Responder (Join Offer)
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs text-[#475569] font-mono tabular-nums">
          <span>Protocol: TOSS1 (v1)</span>
          <span aria-hidden="true">·</span>
          <span>ICE State: {iceGatheringState}</span>
          <span aria-hidden="true">·</span>
          <span>Gathered Candidates: {iceCandidateCount}</span>
        </div>
      </div>

      {/* Main Two-Column Pairing Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {/* Column 1: Outgoing Payload Generator (Offer or Answer) */}
        <div className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-lg p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 border-b border-[#E2E8F0] pb-3">
              <div>
                <h2 className="text-lg md:text-xl font-semibold tracking-tight text-[#0F172A]">
                  {roleTab === 'initiator' ? 'Step 1: Generate Outgoing Offer' : 'Step 2: Share Generated Answer'}
                </h2>
                <p className="text-xs text-[#475569] mt-0.5">
                  Full non-trickle ICE gathering embeds host and STUN candidates into a single signed payload.
                </p>
              </div>
              {roleTab === 'initiator' && (
                <button
                  type="button"
                  onClick={handleGenerateOffer}
                  disabled={busy}
                  className="min-h-[44px] px-4 py-2 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded-md hover:bg-[#1E293B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {localPayload?.type === 'offer' ? 'Regenerate Offer' : 'Create Offer'}
                </button>
              )}
            </div>

            {!localPayload ? (
              <div className="bg-[#F8FAFC] p-6 rounded-md text-center space-y-3">
                <p className="text-sm text-[#475569]">
                  {roleTab === 'initiator'
                    ? 'No active Offer generated yet. Click "Create Offer" to initialize RTCPeerConnection and gather ICE candidates.'
                    : 'Paste or scan an Offer from Peer A in the right column first to generate your Answer payload.'}
                </p>
                {roleTab === 'initiator' && (
                  <button
                    type="button"
                    onClick={handleGenerateOffer}
                    disabled={busy}
                    className="min-h-[44px] px-4 py-2 bg-[#0F172A] text-[#FFFFFF] text-sm font-semibold rounded-md hover:bg-[#1E293B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Create Offer Now
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#475569] font-mono tabular-nums">
                  <span>Role: {localPayload.type.toUpperCase()}</span>
                  <span aria-hidden="true">·</span>
                  <span>Session: {localPayload.sessionId}</span>
                  <span aria-hidden="true">·</span>
                  <span>Size: {formatBytes(localToken.length)}</span>
                  <span aria-hidden="true">·</span>
                  <span>Candidates: {localPayload.candidates.length}</span>
                </div>

                {/* QR Mode & Frame Controls */}
                <div className="bg-[#F8FAFC] p-4 rounded-md space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex p-1 bg-[#FFFFFF] border border-[#E2E8F0] rounded">
                      <button
                        type="button"
                        onClick={() => setQrMode('single')}
                        className={`min-h-[36px] px-3 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          qrMode === 'single'
                            ? 'bg-[#0F172A] text-[#FFFFFF]'
                            : 'text-[#475569] hover:text-[#0F172A]'
                        }`}
                      >
                        Single-Frame QR
                      </button>
                      <button
                        type="button"
                        onClick={() => setQrMode('multi')}
                        className={`min-h-[36px] px-3 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          qrMode === 'multi'
                            ? 'bg-[#0F172A] text-[#FFFFFF]'
                            : 'text-[#475569] hover:text-[#0F172A]'
                        }`}
                      >
                        Multi-Frame QR ({splitTokenIntoQrFrames(localToken, localPayload.sessionId, 160).length} frames)
                      </button>
                    </div>

                    {qrMode === 'multi' && frames.length > 1 && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setActiveFrameIdx((prev) => (prev - 1 + frames.length) % frames.length)}
                          className="min-h-[36px] px-2.5 py-1 border border-[#CBD5E1] bg-[#FFFFFF] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Prev Frame
                        </button>
                        <span className="text-xs font-mono tabular-nums text-[#0F172A]">
                          {activeFrameIdx + 1} / {frames.length}
                        </span>
                        <button
                          type="button"
                          onClick={() => setActiveFrameIdx((prev) => (prev + 1) % frames.length)}
                          className="min-h-[36px] px-2.5 py-1 border border-[#CBD5E1] bg-[#FFFFFF] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Next Frame
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoCycleQr((v) => !v)}
                          className="min-h-[36px] px-2.5 py-1 border border-[#CBD5E1] bg-[#FFFFFF] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {autoCycleQr && !reducedMotion ? 'Pause Cycle' : 'Auto Cycle'}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col sm:flex-row items-center gap-4">
                    <div
                      data-testid="pairing-qr-display"
                      className="w-44 h-44 bg-[#FFFFFF] border border-[#E2E8F0] rounded p-2 shrink-0 flex items-center justify-center"
                    >
                      {qrSvgMarkup ? (
                        <div
                          className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                          dangerouslySetInnerHTML={{ __html: qrSvgMarkup }}
                        />
                      ) : (
                        <span className="text-xs text-[#475569]">Rendering QR...</span>
                      )}
                    </div>

                    <div className="flex-1 space-y-2 w-full">
                      <label htmlFor="outgoing-toss-token" className="block text-xs font-semibold text-[#0F172A]">
                        Versioned Signaling Payload (TOSS1)
                      </label>
                      <textarea
                        id="outgoing-toss-token"
                        readOnly
                        rows={4}
                        value={localToken}
                        className="w-full p-2.5 text-xs font-mono bg-[#FFFFFF] border border-[#CBD5E1] rounded text-[#0F172A] focus-visible:outline-2 focus-visible:outline-[#0F172A]"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleCopyToken}
                          className="min-h-[40px] px-3 py-1.5 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded hover:bg-[#1E293B] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {copyFeedback || 'Copy Payload'}
                        </button>
                        <button
                          type="button"
                          onClick={handleExportTossFile}
                          className="min-h-[40px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Export .toss File
                        </button>
                        {qrMode === 'multi' && (
                          <button
                            type="button"
                            onClick={handleLoadCurrentQrFramesIntoAssembler}
                            className="min-h-[40px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Test Frame Reassembly
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-[#E2E8F0] pt-3 flex items-center justify-between text-xs text-[#475569]">
            <span>DTLS Fingerprint: {localPayload ? localPayload.fingerprint.slice(0, 29) + '...' : 'Awaiting local description'}</span>
            <span className="font-mono tabular-nums">SCTP Port: {localPayload?.sctpPort ?? 5000}</span>
          </div>
        </div>

        {/* Column 2: Incoming Payload Importer (Paste, .toss File, or Multi-Frame QR Scanner) */}
        <div className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-lg p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 border-b border-[#E2E8F0] pb-3">
              <div>
                <h2 className="text-lg md:text-xl font-semibold tracking-tight text-[#0F172A]">
                  {roleTab === 'initiator'
                    ? 'Step 2: Accept Responder Answer'
                    : 'Step 1: Import Initiator Offer'}
                </h2>
                <p className="text-xs text-[#475569] mt-0.5">
                  Paste a TOSS1 payload, import a .toss file, or scan single/multi-frame QR packets.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".toss,application/json,text/plain"
                  onChange={handleImportTossFile}
                  className="hidden"
                  id="import-toss-file-input"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="min-h-[44px] px-3 py-2 border border-[#CBD5E1] bg-[#F8FAFC] text-[#0F172A] text-xs font-semibold rounded-md hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Import .toss File
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="incoming-toss-token" className="block text-xs font-semibold text-[#0F172A]">
                {roleTab === 'initiator' ? 'Paste Peer B Answer Token' : 'Paste Peer A Offer Token'}
              </label>
              <textarea
                id="incoming-toss-token"
                rows={4}
                value={remoteInput}
                onChange={(e) => setRemoteInput(e.target.value)}
                placeholder="TOSS1.RAW.<crc32>.<base64url> or JSON .toss file content"
                className="w-full p-2.5 text-xs font-mono bg-[#F8FAFC] border border-[#CBD5E1] rounded text-[#0F172A] focus-visible:outline-2 focus-visible:outline-[#0F172A]"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleProcessRemoteInput()}
                  disabled={busy}
                  className="min-h-[44px] px-4 py-2 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded-md hover:bg-[#1E293B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {roleTab === 'initiator' ? 'Verify & Complete Answer' : 'Verify Offer & Create Answer'}
                </button>

                <button
                  type="button"
                  onClick={scannerActive ? stopCameraScanner : startCameraScanner}
                  className="min-h-[44px] px-3 py-2 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded-md hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {scannerActive ? 'Stop QR Camera' : 'Start QR Camera'}
                </button>
              </div>
            </div>

            {scannerActive && (
              <div className="bg-[#F8FAFC] p-3 rounded-md space-y-2">
                <div className="flex items-center justify-between text-xs text-[#475569]">
                  <span>Live Camera QR Stream (Explicit Start/Stop)</span>
                  <button
                    type="button"
                    onClick={stopCameraScanner}
                    className="text-xs font-semibold text-[#DC2626] hover:underline cursor-pointer"
                  >
                    Release Camera
                  </button>
                </div>
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="w-full h-36 object-cover bg-[#0F172A] rounded"
                />
              </div>
            )}

            {/* Multi-Frame QR Packet Assembler */}
            <div className="border-t border-[#E2E8F0] pt-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#0F172A]">Multi-Frame QR Reassembler</span>
                <span className="font-mono tabular-nums text-[#475569]">
                  Frames: {assemblyStatus.receivedCount} / {assemblyStatus.totalFrames || 0}{' '}
                  {assemblyStatus.complete ? '(Complete)' : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="qr-frame-packet-input" className="sr-only">
                  QR Frame Packet String
                </label>
                <input
                  id="qr-frame-packet-input"
                  type="text"
                  value={frameInputText}
                  onChange={(e) => setFrameInputText(e.target.value)}
                  placeholder="TOSS1F|1/3|sess|chunk..."
                  className="flex-1 min-h-[40px] px-3 py-1.5 text-xs font-mono bg-[#F8FAFC] border border-[#CBD5E1] rounded text-[#0F172A]"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (frameInputText.trim()) {
                      handleIngestQrFrame(frameInputText);
                      setFrameInputText('');
                    }
                  }}
                  className="min-h-[40px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Add Frame
                </button>
                {assembledPackets.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAssembledPackets([])}
                    className="min-h-[40px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#475569] text-xs font-semibold rounded hover:text-[#0F172A] whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Section 5 Failure State Verifier Controls */}
          <div className="border-t border-[#E2E8F0] pt-4 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[#0F172A]">
                Section 5 Failure State Diagnostics
              </h3>
              <span className="text-xs text-[#475569]">Verify deterministic error handling</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(FAILURE_DESCRIPTIONS) as SignalingFailureCode[]).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => onTriggerFailureState(code)}
                  className={`min-h-[36px] px-2.5 py-1 text-xs font-mono rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    signalingError?.code === code
                      ? 'bg-[#0F172A] text-[#FFFFFF] border-[#0F172A]'
                      : 'bg-[#F8FAFC] text-[#475569] border-[#E2E8F0] hover:text-[#0F172A] hover:border-[#CBD5E1]'
                  }`}
                >
                  {code}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
