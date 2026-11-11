import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  CalibratedEdge,
  GesturePhase,
  RectNormalized,
  createInitialGestureTracker,
  stepGestureMachine,
  computePerspectiveTilt,
  PINCH_ENTER_THRESHOLD,
  PINCH_EXIT_THRESHOLD,
} from '../utils/gestureMachine';
import { computeSha256Hex, formatBytes } from '../utils/crypto';
import { TransferSourceType } from '../utils/transferProtocol';

interface StageWorkspaceProps {
  onThrowRegionBlob: (options: {
    blob: Blob;
    name: string;
    mimeType: string;
    source: TransferSourceType;
    captureLabel: string;
    dimensions: { width: number; height: number };
  }) => Promise<void>;
  reducedMotion: boolean;
  isConnected: boolean;
}

type StageSourceMode = 'synthetic' | 'display-media' | 'imported-image';

export const StageWorkspace: React.FC<StageWorkspaceProps> = ({
  onThrowRegionBlob,
  reducedMotion,
  isConnected,
}) => {
  const [sourceMode, setSourceMode] = useState<StageSourceMode>('synthetic');
  const [captureLabel, setCaptureLabel] = useState<string>(
    'Local Stage Canvas Buffer (Synthetic Engineering Reference — Not Live OS Screen)'
  );
  const [displaySurfaceType, setDisplaySurfaceType] = useState<string>('local-canvas');
  const [stageError, setStageError] = useState<string | null>(null);

  // Normalized crop rectangle [0..1]
  const [cropRect, setCropRect] = useState<RectNormalized>({
    x: 0.22,
    y: 0.20,
    width: 0.48,
    height: 0.52,
  });

  // Cropped PNG Blob output & metadata
  const [croppedBlob, setCroppedBlob] = useState<Blob | null>(null);
  const [croppedPreviewUrl, setCroppedPreviewUrl] = useState<string>('');
  const [croppedPixelDims, setCroppedPixelDims] = useState<{ width: number; height: number }>({
    width: 460,
    height: 290,
  });
  const [croppedSha256, setCroppedSha256] = useState<string>('');

  // Phase 4 & 6 Hand / Pointer Gesture Controls
  const [calibratedEdge, setCalibratedEdge] = useState<CalibratedEdge>('right');
  const [calibratingMode, setCalibratingMode] = useState<boolean>(false);
  const [gesturePhase, setGesturePhase] = useState<GesturePhase>('IDLE');
  const [lastGestureOutcome, setLastGestureOutcome] = useState<string>(
    'Ready: grab cropped region and throw toward calibrated right edge'
  );

  // Lazy MediaPipe Hand Tracking state (only discrete status in React state; per-frame data in refs)
  const [handCameraActive, setHandCameraActive] = useState(false);
  const [handModelStatus, setHandModelStatus] = useState<'unloaded' | 'loading' | 'ready' | 'fallback'>('unloaded');
  const [showCameraPreview, setShowCameraPreview] = useState(false);

  // DOM & Mutable Refs (zero per-frame React state updates)
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const floatingCardRef = useRef<HTMLDivElement | null>(null);
  const cursorDotRef = useRef<HTMLDivElement | null>(null);
  const telemetryReadoutRef = useRef<HTMLSpanElement | null>(null);

  const displayVideoRef = useRef<HTMLVideoElement | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const importedImageRef = useRef<HTMLImageElement | null>(null);

  const handVideoRef = useRef<HTMLVideoElement | null>(null);
  const handStreamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<any>(null);
  const handRafRef = useRef<number | null>(null);

  const trackerRef = useRef(createInitialGestureTracker(cropRect));
  const cropRectRef = useRef(cropRect);
  cropRectRef.current = cropRect;
  const calibratedEdgeRef = useRef(calibratedEdge);
  calibratedEdgeRef.current = calibratedEdge;
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  /**
   * Draws the Synthetic Engineering Blueprint on the Stage Canvas when not capturing live display media
   */
  const renderStageCanvas = useCallback(() => {
    const canvas = stageCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    if (sourceMode === 'display-media' && displayVideoRef.current && displayVideoRef.current.readyState >= 2) {
      ctx.drawImage(displayVideoRef.current, 0, 0, w, h);
      return;
    }

    if (sourceMode === 'imported-image' && importedImageRef.current) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(importedImageRef.current, 0, 0, w, h);
      return;
    }

    // Crisp technical reference canvas (Zero gradients, flat architectural drafting grid)
    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = 0; x <= w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Technical schematic blocks inside canvas
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 2;
    ctx.fillRect(220, 115, 440, 270);
    ctx.strokeRect(220, 115, 440, 270);

    ctx.fillStyle = '#0F172A';
    ctx.font = '700 18px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('TOSS STAGE REFERENCE FRAME // REV 1.0', 244, 152);

    ctx.fillStyle = '#475569';
    ctx.font = '400 13px "IBM Plex Mono", monospace';
    ctx.fillText('SURFACE: 960x540PX DETERMINISTIC BUFFER', 244, 180);
    ctx.fillText('COLORIMETRY: SRGB FLAT TOKEN PALETTE', 244, 202);

    // Bar chart telemetry block inside the reference frame
    const bars = [110, 165, 95, 190, 145, 210, 170];
    bars.forEach((bw, idx) => {
      const bx = 244 + idx * 56;
      const by = 345 - bw * 0.55;
      const bh = bw * 0.55;
      ctx.fillStyle = idx % 2 === 0 ? '#0F172A' : '#475569';
      ctx.fillRect(bx, by, 36, bh);
    });

    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.strokeRect(40, 40, w - 80, h - 80);
    ctx.fillStyle = '#475569';
    ctx.font = '600 12px "IBM Plex Mono", monospace';
    ctx.fillText('ORIGIN (0,0)', 52, 60);
    ctx.fillText(`EXTENT (${w},${h})`, w - 165, h - 52);
  }, [sourceMode]);

  /**
   * Extracts a real PNG Blob from the currently selected cropRect on the Stage Canvas
   */
  const extractCroppedPngBlob = useCallback(async () => {
    const stageCanvas = stageCanvasRef.current;
    if (!stageCanvas) return;

    renderStageCanvas();

    const sx = Math.round(cropRect.x * stageCanvas.width);
    const sy = Math.round(cropRect.y * stageCanvas.height);
    const sw = Math.max(32, Math.round(cropRect.width * stageCanvas.width));
    const sh = Math.max(32, Math.round(cropRect.height * stageCanvas.height));

    const offscreen = document.createElement('canvas');
    offscreen.width = sw;
    offscreen.height = sh;
    const octx = offscreen.getContext('2d');
    if (!octx) return;

    octx.drawImage(stageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const blob = await new Promise<Blob | null>((resolve) =>
      offscreen.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob) return;

    const ab = await blob.arrayBuffer();
    const sha = await computeSha256Hex(ab);

    setCroppedPixelDims({ width: sw, height: sh });
    setCroppedSha256(sha);
    setCroppedBlob(blob);
    setCroppedPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
  }, [cropRect, renderStageCanvas]);

  useEffect(() => {
    extractCroppedPngBlob();
  }, [extractCroppedPngBlob]);

  useEffect(() => {
    return () => {
      stopDisplayCapture();
      stopHandCamera();
    };
  }, []);

  /**
   * Phase 5: Explicit getDisplayMedia capture with honest surface labeling
   */
  const startDisplayCapture = async () => {
    setStageError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setStageError('getDisplayMedia is not supported in this browser environment. Using Synthetic Reference Stage.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' } as MediaTrackConstraints,
        audio: false,
      });
      displayStreamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack?.getSettings() as MediaTrackSettings & { displaySurface?: string };
      const surface = settings?.displaySurface || 'surface';
      setDisplaySurfaceType(surface);

      const surfaceHumanLabel =
        surface === 'monitor'
          ? 'Full Screen Display Stream (getDisplayMedia monitor)'
          : surface === 'window'
          ? 'Application Window Stream (getDisplayMedia window)'
          : surface === 'browser'
          ? 'Browser Tab Stream (getDisplayMedia browser)'
          : `Live Display Stream (${surface})`;

      setCaptureLabel(
        `${surfaceHumanLabel} — Captures only the user-selected surface; cannot inspect external OS windows`
      );
      setSourceMode('display-media');

      if (displayVideoRef.current) {
        displayVideoRef.current.srcObject = stream;
        await displayVideoRef.current.play();
      }

      videoTrack?.addEventListener('ended', () => {
        stopDisplayCapture();
      });

      setTimeout(() => {
        extractCroppedPngBlob();
      }, 250);
    } catch {
      setStageError(
        'Display capture permission was declined or blocked by iframe policy. Synthetic Reference Stage remains active.'
      );
    }
  };

  const stopDisplayCapture = () => {
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach((t) => t.stop());
      displayStreamRef.current = null;
    }
    setSourceMode('synthetic');
    setDisplaySurfaceType('local-canvas');
    setCaptureLabel(
      'Local Stage Canvas Buffer (Synthetic Engineering Reference — Not Live OS Screen)'
    );
  };

  const handleImportStageImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      importedImageRef.current = img;
      setSourceMode('imported-image');
      setDisplaySurfaceType('imported-bitmap');
      setCaptureLabel(
        `Imported Local Image Buffer (${file.name}, ${img.naturalWidth}x${img.naturalHeight}px — Not Live OS Screen)`
      );
      setTimeout(() => extractCroppedPngBlob(), 60);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    e.target.value = '';
  };

  /**
   * Applies DOM transform directly from trackerRef without triggering React re-renders per frame
   */
  const applyPerFrameDomTransform = useCallback(() => {
    const tracker = trackerRef.current;
    const container = stageContainerRef.current;
    const card = floatingCardRef.current;
    const cursorDot = cursorDotRef.current;
    const readout = telemetryReadoutRef.current;

    if (container && cursorDot) {
      const rect = container.getBoundingClientRect();
      const px = tracker.smoothedPos.x * rect.width;
      const py = tracker.smoothedPos.y * rect.height;
      cursorDot.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
    }

    if (readout) {
      const speedPxMs = Math.hypot(tracker.velocity.x, tracker.velocity.y) * 1000;
      readout.textContent = `pos=(${tracker.smoothedPos.x.toFixed(2)}, ${tracker.smoothedPos.y.toFixed(2)}) · v=${speedPxMs.toFixed(2)} u/s · pinch=${tracker.isPinched ? 'CLOSED' : 'OPEN'}`;
    }

    if (!card || !container) return;
    const stageBounds = container.getBoundingClientRect();
    const dxPx = tracker.regionOffset.x * stageBounds.width;
    const dyPx = tracker.regionOffset.y * stageBounds.height;

    if (reducedMotionRef.current) {
      // Reduced-motion variant: zero 3D tilt, clean opacity/border state
      card.style.transition = 'opacity 120ms linear';
      card.style.transform = 'translate3d(0px, 0px, 0px)';
      card.style.opacity = tracker.phase === 'RELEASE_THROW' ? '0.25' : '1';
      return;
    }

    if (tracker.phase === 'PINCH_GRAB' || tracker.phase === 'DRAG') {
      const tilt = computePerspectiveTilt(
        tracker.velocity,
        tracker.regionOffset,
        reducedMotionRef.current
      );
      card.style.transition = 'none';
      card.style.transform = `translate3d(${dxPx.toFixed(1)}px, ${dyPx.toFixed(1)}px, 0) perspective(900px) rotateX(${tilt.rotateXDeg}deg) rotateY(${tilt.rotateYDeg}deg) scale(${tilt.scale})`;
    } else if (tracker.phase === 'RELEASE_THROW') {
      const edge = calibratedEdgeRef.current;
      const throwX = edge === 'right' ? stageBounds.width : edge === 'left' ? -stageBounds.width : dxPx;
      const throwY = edge === 'bottom' ? stageBounds.height : edge === 'top' ? -stageBounds.height : dyPx;
      card.style.transition = 'transform 190ms cubic-bezier(0.16, 1, 0.3, 1), opacity 190ms linear';
      card.style.transform = `translate3d(${throwX.toFixed(0)}px, ${throwY.toFixed(0)}px, 0) scale(0.92)`;
      card.style.opacity = '0.15';
      setTimeout(() => {
        if (card) {
          card.style.transition = 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms linear';
          card.style.transform = 'translate3d(0px, 0px, 0px) scale(1)';
          card.style.opacity = '1';
        }
      }, 240);
    } else {
      // Spring-back on CANCEL or IDLE/HOVER
      card.style.transition = 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms linear';
      card.style.transform = 'translate3d(0px, 0px, 0px) perspective(900px) rotateX(0deg) rotateY(0deg) scale(1)';
      card.style.opacity = '1';
    }
  }, []);

  /**
   * Triggers the real WebRTC transfer independently of the throw animation
   */
  const triggerIndependentStageTransfer = useCallback(async () => {
    if (!croppedBlob) return;
    const filename = `stage-region-${croppedPixelDims.width}x${croppedPixelDims.height}-${Date.now().toString().slice(-4)}.png`;
    setLastGestureOutcome(
      `Thrown across calibrated ${calibratedEdgeRef.current.toUpperCase()} edge -> Sending ${filename} (${formatBytes(croppedBlob.size)})`
    );
    try {
      await onThrowRegionBlob({
        blob: croppedBlob,
        name: filename,
        mimeType: 'image/png',
        source: 'stage-region',
        captureLabel,
        dimensions: croppedPixelDims,
      });
    } catch (err: any) {
      setLastGestureOutcome(
        `Throw animation completed; network transfer queued (${err?.message || 'Peer not connected'})`
      );
    }
  }, [croppedBlob, croppedPixelDims, captureLabel, onThrowRegionBlob]);

  const processFrameInput = useCallback(
    (rawPos: { x: number; y: number }, pinchInput: number | boolean, timestampMs: number) => {
      if (calibratingMode && pinchInput === true) {
        // Determine nearest edge from cursor position
        const distances: { edge: CalibratedEdge; d: number }[] = [
          { edge: 'top', d: rawPos.y },
          { edge: 'bottom', d: 1 - rawPos.y },
          { edge: 'left', d: rawPos.x },
          { edge: 'right', d: 1 - rawPos.x },
        ];
        distances.sort((a, b) => a.d - b.d);
        const chosen = distances[0].edge;
        setCalibratedEdge(chosen);
        setCalibratingMode(false);
        setLastGestureOutcome(`Calibrated receiver direction to ${chosen.toUpperCase()} edge.`);
        return;
      }

      const stepResult = stepGestureMachine(
        trackerRef.current,
        rawPos,
        pinchInput,
        cropRectRef.current,
        calibratedEdgeRef.current,
        timestampMs
      );
      trackerRef.current = stepResult.next;
      applyPerFrameDomTransform();

      if (stepResult.phaseChanged) {
        setGesturePhase(stepResult.next.phase);
      }
      if (stepResult.triggeredThrow) {
        triggerIndependentStageTransfer();
      } else if (stepResult.triggeredCancel) {
        setLastGestureOutcome('Released below velocity threshold — region sprung back to Stage.');
      }
    },
    [calibratingMode, applyPerFrameDomTransform, triggerIndependentStageTransfer]
  );

  /**
   * Phase 4: Lazy MediaPipe loading & explicit camera lifecycle
   */
  const startHandCamera = async () => {
    setStageError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStageError('Camera API unavailable. Mouse and touch Stage fallback remains active.');
      return;
    }

    try {
      setHandModelStatus('loading');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      handStreamRef.current = stream;
      setHandCameraActive(true);

      if (handVideoRef.current) {
        handVideoRef.current.srcObject = stream;
        await handVideoRef.current.play().catch(() => {});
      }

      // Lazy load @mediapipe/tasks-vision only when camera hand tracking is explicitly started
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const filesetResolver = await vision.FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );
        handLandmarkerRef.current = await vision.HandLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
        });
        setHandModelStatus('ready');
      } catch {
        // If external WASM CDN is blocked in hermetic sandbox, keep camera stream active with optical/pointer tracking fallback
        setHandModelStatus('fallback');
      }

      const loop = () => {
        if (!handStreamRef.current) return;
        const video = handVideoRef.current;
        if (video && video.readyState >= 2 && handLandmarkerRef.current) {
          try {
            const nowMs = performance.now();
            const res = handLandmarkerRef.current.detectForVideo(video, nowMs);
            if (res?.landmarks && res.landmarks.length > 0) {
              const lm = res.landmarks[0];
              const thumbTip = lm[4];
              const indexTip = lm[8];
              if (thumbTip && indexTip) {
                const midX = 1 - (thumbTip.x + indexTip.x) / 2; // Mirror X for natural facing-user control
                const midY = (thumbTip.y + indexTip.y) / 2;
                const dist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
                processFrameInput({ x: midX, y: midY }, dist, nowMs);
              }
            }
          } catch {
            // Continue loop safely
          }
        }
        handRafRef.current = requestAnimationFrame(loop);
      };
      handRafRef.current = requestAnimationFrame(loop);
    } catch {
      setHandModelStatus('unloaded');
      setHandCameraActive(false);
      setStageError('Camera permission denied. Use Mouse/Touch directly on the Stage to grab and throw.');
    }
  };

  const stopHandCamera = () => {
    if (handRafRef.current) {
      cancelAnimationFrame(handRafRef.current);
      handRafRef.current = null;
    }
    if (handStreamRef.current) {
      handStreamRef.current.getTracks().forEach((t) => t.stop());
      handStreamRef.current = null;
    }
    if (handLandmarkerRef.current) {
      try {
        handLandmarkerRef.current.close();
      } catch {}
      handLandmarkerRef.current = null;
    }
    setHandCameraActive(false);
    setHandModelStatus('unloaded');
  };

  // Mouse & Touch Pointer Fallback handlers (identical state machine)
  const getNormalizedPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return { x, y };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = getNormalizedPointer(e);
    const isButtonsDown = (e.buttons & 1) === 1;
    processFrameInput(pt, isButtonsDown, performance.now());
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getNormalizedPointer(e);
    processFrameInput(pt, true, performance.now());
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = getNormalizedPointer(e);
    processFrameInput(pt, false, performance.now());
  };

  const handleDeterministicThrowButton = async () => {
    const startX = cropRect.x + cropRect.width / 2;
    const startY = cropRect.y + cropRect.height / 2;
    const now = performance.now();
    processFrameInput({ x: startX, y: startY }, false, now);
    processFrameInput({ x: startX, y: startY }, true, now + 16);

    const targetPos =
      calibratedEdge === 'right'
        ? { x: 0.94, y: startY }
        : calibratedEdge === 'left'
        ? { x: 0.06, y: startY }
        : calibratedEdge === 'top'
        ? { x: startX, y: 0.06 }
        : { x: startX, y: 0.94 };

    processFrameInput(targetPos, true, now + 32);
    processFrameInput(targetPos, false, now + 48);
  };

  return (
    <section aria-labelledby="stage-heading" className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-lg p-6 space-y-6">
      {/* Header & Honest Capture Label (Section 8) */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[#E2E8F0] pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#475569] tabular-nums">
            <span>Capture Mode: {sourceMode.toUpperCase()}</span>
            <span aria-hidden="true">·</span>
            <span>Surface: {displaySurfaceType}</span>
            <span aria-hidden="true">·</span>
            <span>Calibrated Edge: {calibratedEdge.toUpperCase()}</span>
          </div>
          <h2 id="stage-heading" className="text-lg md:text-xl font-semibold tracking-tight text-[#0F172A]">
            Interactive Stage, Region Crop & Spatial Gesture Throw
          </h2>
          <p data-testid="honest-capture-label" className="text-xs text-[#475569]">
            Source Disclosure: {captureLabel}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {sourceMode !== 'display-media' ? (
            <button
              type="button"
              onClick={startDisplayCapture}
              className="min-h-[44px] px-3.5 py-2 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded-md hover:bg-[#1E293B] whitespace-nowrap shrink-0 cursor-pointer"
            >
              Capture Display (getDisplayMedia)
            </button>
          ) : (
            <button
              type="button"
              onClick={stopDisplayCapture}
              className="min-h-[44px] px-3.5 py-2 border border-[#DC2626] bg-[#FFFFFF] text-[#DC2626] text-xs font-semibold rounded-md hover:bg-[#F8FAFC] whitespace-nowrap shrink-0 cursor-pointer"
            >
              Stop Display Capture
            </button>
          )}

          <label className="min-h-[44px] px-3.5 py-2 border border-[#CBD5E1] bg-[#F8FAFC] text-[#0F172A] text-xs font-semibold rounded-md hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 flex items-center cursor-pointer">
            <span>Load Image to Stage</span>
            <input
              type="file"
              accept="image/*"
              onChange={handleImportStageImage}
              className="hidden"
            />
          </label>

          <button
            type="button"
            onClick={handCameraActive ? stopHandCamera : startHandCamera}
            className="min-h-[44px] px-3.5 py-2 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded-md hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
          >
            {handCameraActive ? 'Stop Hand Camera' : 'Start Hand Camera (MediaPipe)'}
          </button>
        </div>
      </div>

      {stageError && (
        <div role="status" className="bg-[#F8FAFC] border border-[#CBD5E1] rounded-md p-3 text-xs text-[#0F172A] flex items-center justify-between gap-4">
          <span>{stageError}</span>
          <button
            type="button"
            onClick={() => setStageError(null)}
            className="px-2.5 py-1 border border-[#CBD5E1] bg-[#FFFFFF] rounded font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Hand Control, Hysteresis & Edge Calibration Toolbar */}
      <div className="bg-[#F8FAFC] p-4 rounded-md space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#0F172A]">
            <span className="font-semibold">Send Edge Calibration:</span>
            {(['top', 'right', 'bottom', 'left'] as CalibratedEdge[]).map((edge) => (
              <button
                key={edge}
                type="button"
                onClick={() => {
                  setCalibratedEdge(edge);
                  setLastGestureOutcome(`Calibrated send edge set to ${edge.toUpperCase()}`);
                }}
                className={`min-h-[36px] px-3 py-1 rounded text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  calibratedEdge === edge
                    ? 'bg-[#0F172A] text-[#FFFFFF] border-[#0F172A]'
                    : 'bg-[#FFFFFF] text-[#475569] border-[#CBD5E1] hover:text-[#0F172A]'
                }`}
              >
                {edge.charAt(0).toUpperCase() + edge.slice(1)} Edge
              </button>
            ))}
            <button
              type="button"
              onClick={() => setCalibratingMode((v) => !v)}
              className={`min-h-[36px] px-3 py-1 rounded text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                calibratingMode
                  ? 'bg-[#D97706] text-[#FFFFFF] border-[#D97706]'
                  : 'bg-[#FFFFFF] text-[#0F172A] border-[#CBD5E1] hover:bg-[#F1F5F9]'
              }`}
            >
              {calibratingMode ? 'Click/Pinch Target Edge Now...' : 'Interactive Point Calibration'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums text-[#475569]">
            <span>State: <strong className="text-[#0F172A]">{gesturePhase}</strong></span>
            <span aria-hidden="true">·</span>
            <span>Hysteresis: {PINCH_ENTER_THRESHOLD}/{PINCH_EXIT_THRESHOLD}</span>
            <span aria-hidden="true">·</span>
            <span ref={telemetryReadoutRef}>pos=(0.50, 0.50) · v=0.00 u/s · pinch=OPEN</span>
          </div>
        </div>

        {handCameraActive && (
          <div className="border-t border-[#E2E8F0] pt-3 flex flex-wrap items-center justify-between gap-4">
            <div className="text-xs text-[#475569] font-mono">
              <span>MediaPipe HandLandmarker: {handModelStatus.toUpperCase()}</span>
              <span aria-hidden="true"> · </span>
              <span>Per-frame landmarks isolated from React state</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowCameraPreview((v) => !v)}
                className="min-h-[36px] px-3 py-1 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded cursor-pointer"
              >
                {showCameraPreview ? 'Hide Camera Preview' : 'Show Camera Preview'}
              </button>
            </div>
          </div>
        )}

        <video
          ref={handVideoRef}
          muted
          playsInline
          className={handCameraActive && showCameraPreview ? 'w-48 h-36 object-cover bg-[#0F172A] rounded border border-[#CBD5E1]' : 'hidden'}
        />
        <video ref={displayVideoRef} muted playsInline className="hidden" />
      </div>

      {/* Main Stage Interactive Viewport + Region Crop & PNG Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
        {/* Left 2 Columns: Interactive Stage Surface */}
        <div className="lg:col-span-2 flex flex-col space-y-3">
          <div
            ref={stageContainerRef}
            data-testid="interactive-stage-surface"
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            className="relative w-full aspect-video bg-[#F8FAFC] border border-[#CBD5E1] rounded-md overflow-hidden select-none touch-none cursor-grab active:cursor-grabbing"
          >
            {/* Base Stage Canvas */}
            <canvas
              ref={stageCanvasRef}
              width={960}
              height={540}
              className="w-full h-full object-contain pointer-events-none"
            />

            {/* Calibrated Send Edge Indicator Bar (Strict flat token border, no glow) */}
            <div
              aria-hidden="true"
              className={`absolute pointer-events-none bg-[#0F172A] text-[#FFFFFF] text-[10px] font-mono font-semibold px-1.5 py-0.5 flex items-center justify-center ${
                calibratedEdge === 'top'
                  ? 'top-0 left-0 right-0 h-6'
                  : calibratedEdge === 'bottom'
                  ? 'bottom-0 left-0 right-0 h-6'
                  : calibratedEdge === 'left'
                  ? 'top-0 bottom-0 left-0 w-6 [writing-mode:vertical-rl]'
                  : 'top-0 bottom-0 right-0 w-6 [writing-mode:vertical-rl]'
              }`}
            >
              <span className="whitespace-nowrap">
                {calibratedEdge === 'left' || calibratedEdge === 'right'
                  ? `SEND EDGE: ${calibratedEdge.toUpperCase()}`
                  : `CALIBRATED SEND EDGE: ${calibratedEdge.toUpperCase()} — THROW REGION HERE`}
              </span>
            </div>

            {/* Cropped Grabbable Region Card */}
            <div
              ref={floatingCardRef}
              data-testid="stage-grabbable-region"
              style={{
                left: `${cropRect.x * 100}%`,
                top: `${cropRect.y * 100}%`,
                width: `${cropRect.width * 100}%`,
                height: `${cropRect.height * 100}%`,
              }}
              className={`absolute pointer-events-none overflow-hidden border-2 rounded bg-[#FFFFFF]/95 flex flex-col justify-between p-1.5 sm:p-2 ${
                gesturePhase === 'PINCH_GRAB' || gesturePhase === 'DRAG'
                  ? 'border-[#16A34A]'
                  : gesturePhase === 'HOVER'
                  ? 'border-[#0F172A]'
                  : 'border-[#475569]'
              }`}
            >
              <div className="flex items-center justify-between gap-1 bg-[#0F172A] text-[#FFFFFF] px-1.5 py-0.5 text-[10px] sm:text-[11px] font-mono tabular-nums whitespace-nowrap overflow-hidden">
                <span className="truncate">
                  {croppedPixelDims.width}x{croppedPixelDims.height}px
                </span>
                <span className="shrink-0">{gesturePhase}</span>
              </div>

              {croppedPreviewUrl && (
                <img
                  src={croppedPreviewUrl}
                  alt="Selected stage crop region"
                  referrerPolicy="no-referrer"
                  className="w-full flex-1 min-h-0 object-cover my-1"
                />
              )}

              <div className="hidden sm:flex bg-[#F8FAFC] px-2 py-0.5 text-[11px] font-mono text-[#0F172A] items-center justify-between tabular-nums whitespace-nowrap overflow-hidden">
                <span className="truncate">PNG: {croppedBlob ? formatBytes(croppedBlob.size) : '...'}</span>
                <span className="shrink-0">-&gt; {calibratedEdge.toUpperCase()}</span>
              </div>
            </div>

            {/* Smoothed Gesture Cursor Indicator */}
            <div
              ref={cursorDotRef}
              aria-hidden="true"
              className="absolute top-0 left-0 w-4 h-4 -ml-2 -mt-2 border-2 border-[#0F172A] bg-[#FFFFFF] rounded-none pointer-events-none"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#475569]">
            <span data-testid="stage-gesture-outcome" className="font-mono text-[#0F172A]">
              {lastGestureOutcome}
            </span>
            <span>Pointer &amp; Touch Fallback Active (Pinch or drag region toward {calibratedEdge} edge)</span>
          </div>
        </div>

        {/* Right Column: Region Crop Presets & PNG Output Inspector */}
        <div className="bg-[#F8FAFC] p-4 rounded-md flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[#0F172A]">Region Crop &amp; PNG Output</h3>
              <p className="text-xs text-[#475569] mt-0.5">
                Adjust normalized region bounds or choose a preset crop before throwing to peer.
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setCropRect({ x: 0.22, y: 0.20, width: 0.48, height: 0.52 })}
                className="min-h-[36px] px-2.5 py-1 bg-[#FFFFFF] border border-[#CBD5E1] text-xs font-semibold text-[#0F172A] rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Schematic Core
              </button>
              <button
                type="button"
                onClick={() => setCropRect({ x: 0.08, y: 0.10, width: 0.40, height: 0.40 })}
                className="min-h-[36px] px-2.5 py-1 bg-[#FFFFFF] border border-[#CBD5E1] text-xs font-semibold text-[#0F172A] rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Top-Left Quadrant
              </button>
              <button
                type="button"
                onClick={() => setCropRect({ x: 0.10, y: 0.12, width: 0.78, height: 0.72 })}
                className="min-h-[36px] px-2.5 py-1 bg-[#FFFFFF] border border-[#CBD5E1] text-xs font-semibold text-[#0F172A] rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Wide Stage Frame
              </button>
            </div>

            {/* Numeric Sliders for Precise Region Cropping */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <label className="block space-y-1">
                <span className="font-mono text-[#475569] tabular-nums">Crop X ({Math.round(cropRect.x * 100)}%)</span>
                <input
                  type="range"
                  min={0.02}
                  max={0.55}
                  step={0.02}
                  value={cropRect.x}
                  onChange={(e) => setCropRect((prev) => ({ ...prev, x: parseFloat(e.target.value) }))}
                  className="w-full accent-[#0F172A]"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-mono text-[#475569] tabular-nums">Crop Y ({Math.round(cropRect.y * 100)}%)</span>
                <input
                  type="range"
                  min={0.02}
                  max={0.55}
                  step={0.02}
                  value={cropRect.y}
                  onChange={(e) => setCropRect((prev) => ({ ...prev, y: parseFloat(e.target.value) }))}
                  className="w-full accent-[#0F172A]"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-mono text-[#475569] tabular-nums">Width ({Math.round(cropRect.width * 100)}%)</span>
                <input
                  type="range"
                  min={0.20}
                  max={0.85}
                  step={0.02}
                  value={cropRect.width}
                  onChange={(e) => setCropRect((prev) => ({ ...prev, width: parseFloat(e.target.value) }))}
                  className="w-full accent-[#0F172A]"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-mono text-[#475569] tabular-nums">Height ({Math.round(cropRect.height * 100)}%)</span>
                <input
                  type="range"
                  min={0.20}
                  max={0.85}
                  step={0.02}
                  value={cropRect.height}
                  onChange={(e) => setCropRect((prev) => ({ ...prev, height: parseFloat(e.target.value) }))}
                  className="w-full accent-[#0F172A]"
                />
              </label>
            </div>

            {/* Extracted PNG Blob Preview & Telemetry */}
            <div className="border-t border-[#E2E8F0] pt-3 space-y-2">
              <div className="text-xs font-semibold text-[#0F172A]">Cropped PNG Blob Preview</div>
              {croppedPreviewUrl ? (
                <img
                  src={croppedPreviewUrl}
                  alt="Cropped PNG output preview"
                  referrerPolicy="no-referrer"
                  className="w-full h-28 object-contain bg-[#FFFFFF] border border-[#E2E8F0] rounded p-1"
                />
              ) : (
                <div className="w-full h-28 bg-[#FFFFFF] border border-[#E2E8F0] rounded flex items-center justify-center text-xs text-[#475569]">
                  Generating PNG...
                </div>
              )}
              <div className="text-xs font-mono text-[#475569] tabular-nums space-y-0.5">
                <div>Dimensions: {croppedPixelDims.width} x {croppedPixelDims.height} px</div>
                <div>Blob Size: {croppedBlob ? formatBytes(croppedBlob.size) : '0 B'} (image/png)</div>
                <div className="truncate" title={croppedSha256}>
                  SHA-256: {croppedSha256 ? croppedSha256.slice(0, 20) + '...' : 'computing'}
                </div>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleDeterministicThrowButton}
            disabled={!croppedBlob}
            className="w-full min-h-[44px] px-4 py-2 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded-md hover:bg-[#1E293B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isConnected
              ? `Throw Cropped PNG Toward ${calibratedEdge.toUpperCase()} Edge`
              : `Simulate Throw (${calibratedEdge.toUpperCase()} Edge)`}
          </button>
        </div>
      </div>
    </section>
  );
};
