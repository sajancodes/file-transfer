/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import {
  SpatialPhotoItem,
  SpatialStagePhase,
  HandPoint,
  normalizeRoomCode,
  isHandInPhoneDeliveryZone,
  computeCinematicHandTransform,
} from './utils/spatialToss';
import {
  smoothPoint2D,
  evaluatePinchHysteresis,
} from './utils/gestureMachine';

const CURATED_PHOTOS: SpatialPhotoItem[] = [
  {
    id: 'alpine-pavilion',
    title: 'Alpine Glass Pavilion',
    subtitle: '3840 × 2160 · RAW Editorial',
    dataUrl: '/src/assets/images/photo_alpine_architecture_1794361911541.jpg',
  },
  {
    id: 'desert-monolith',
    title: 'Desert Obsidian Monolith',
    subtitle: '3840 × 2160 · RAW Editorial',
    dataUrl: '/src/assets/images/photo_desert_monolith_1794361911530.jpg',
  },
  {
    id: 'coastal-horizon',
    title: 'Volcanic Coastline',
    subtitle: '3840 × 2160 · RAW Editorial',
    dataUrl: '/src/assets/images/photo_coastal_horizon_1794361912038.jpg',
  },
];

interface DeliveredPhotoPayload {
  id: string;
  title: string;
  dataUrl: string;
  timestamp: number;
}

export default function App() {
  // Determine initial mode & code from URL (?code=4829&role=phone)
  const initialParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const urlCode = normalizeRoomCode(initialParams?.get('code') || '') || '4829';
  const urlRole = initialParams?.get('role') === 'phone' ? 'phone' : 'computer';

  const [deviceRole, setDeviceRole] = useState<'computer' | 'phone'>(urlRole);
  const [roomCode, setRoomCode] = useState<string>(urlCode);
  const [phoneCodeInput, setPhoneCodeInput] = useState<string>(urlCode);
  const [phoneConnected, setPhoneConnected] = useState<boolean>(false);
  const [showCodeModal, setShowCodeModal] = useState<boolean>(false);
  const [showPipPhonePreview, setShowPipPhonePreview] = useState<boolean>(true);
  const [qrSvg, setQrSvg] = useState<string>('');

  // Photo Library & Open Photo on Computer Screen
  const [photos, setPhotos] = useState<SpatialPhotoItem[]>(CURATED_PHOTOS);
  const [activePhoto, setActivePhoto] = useState<SpatialPhotoItem | null>(CURATED_PHOTOS[0]);
  const [stagePhase, setStagePhase] = useState<SpatialStagePhase>('PHOTO_OPEN');
  const [statusCaption, setStatusCaption] = useState<string>(
    'Pinch or grab the photo with your hand, then bring it toward your phone edge to deliver.'
  );

  // Delivered Photo on Phone (Opens in Full Screen on Phone)
  const [deliveredPhoto, setDeliveredPhoto] = useState<DeliveredPhotoPayload | null>(null);
  const [phoneFullScreenOpen, setPhoneFullScreenOpen] = useState<boolean>(false);

  // Full-Screen Camera & Hand Tracking state
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [handDetected, setHandDetected] = useState<boolean>(false);
  const [handPinching, setHandPinching] = useState<boolean>(false);

  // Refs for 60fps per-frame camera & hand tracking (isolated from React re-renders)
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const photoStageElementRef = useRef<HTMLDivElement | null>(null);
  const handOrbElementRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<any>(null);
  const rafIdRef = useRef<number | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  const handStateRef = useRef<{
    pos: HandPoint;
    velocity: HandPoint;
    isPinched: boolean;
    lastTimeMs: number;
    landmarks: { x: number; y: number }[] | null;
    trail: { x: number; y: number; t: number }[];
  }>({
    pos: { x: 0.5, y: 0.5 },
    velocity: { x: 0, y: 0 },
    isPinched: false,
    lastTimeMs: 0,
    landmarks: null,
    trail: [],
  });

  const stagePhaseRef = useRef<SpatialStagePhase>(stagePhase);
  stagePhaseRef.current = stagePhase;

  const activePhotoRef = useRef<SpatialPhotoItem | null>(activePhoto);
  activePhotoRef.current = activePhoto;

  // Generate QR code for instant phone pairing
  useEffect(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    const pairUrl = `${origin}/?code=${roomCode}&role=phone`;
    QRCode.toString(pairUrl, {
      type: 'svg',
      margin: 1,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    })
      .then((svg) => setQrSvg(svg))
      .catch(() => {});
  }, [roomCode]);

  // Connect to real-time 4-digit room on server + BroadcastChannel
  useEffect(() => {
    const cleanCode = normalizeRoomCode(roomCode) || '4829';

    // Register role in room
    fetch(`/api/rooms/${cleanCode}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: deviceRole }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.phoneConnected) {
          setPhoneConnected(true);
        }
        if (data?.latestPhoto && deviceRole === 'phone') {
          setDeliveredPhoto(data.latestPhoto);
          setPhoneFullScreenOpen(true);
        }
      })
      .catch(() => {});

    // Subscribe to Server-Sent Events for this 4-digit code
    const es = new EventSource(`/api/rooms/${cleanCode}/events`);
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'peer:joined') {
          if (parsed.payload?.phoneConnected) {
            setPhoneConnected(true);
          }
        } else if (parsed.type === 'photo:delivered' && parsed.payload) {
          const incoming = parsed.payload as DeliveredPhotoPayload;
          setDeliveredPhoto(incoming);
          setPhoneFullScreenOpen(true);
          setPhoneConnected(true);
        }
      } catch {
        // Ignore malformed SSE message
      }
    };

    // Also attach BroadcastChannel for instant cross-tab sync
    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(`toss-room-${cleanCode}`);
      broadcastChannelRef.current = bc;
      bc.onmessage = (ev) => {
        const msg = ev.data;
        if (msg?.type === 'phone:connected') {
          setPhoneConnected(true);
        } else if (msg?.type === 'photo:delivered' && msg.photo) {
          setDeliveredPhoto(msg.photo);
          setPhoneFullScreenOpen(true);
          setPhoneConnected(true);
        }
      };
      if (deviceRole === 'phone') {
        bc.postMessage({ type: 'phone:connected', code: cleanCode });
      }
    }

    return () => {
      es.close();
      if (bc) bc.close();
    };
  }, [roomCode, deviceRole]);

  /**
   * Sends the grabbed photo to the connected phone (server SSE + BroadcastChannel)
   */
  const deliverPhotoToPhone = useCallback(
    async (photo: SpatialPhotoItem) => {
      const payload: DeliveredPhotoPayload = {
        id: `${photo.id}-${Date.now()}`,
        title: photo.title,
        dataUrl: photo.dataUrl,
        timestamp: Date.now(),
      };

      // Update local state immediately so PiP phone preview & phone mode open it in full screen
      setDeliveredPhoto(payload);
      setPhoneFullScreenOpen(true);
      setPhoneConnected(true);

      if (broadcastChannelRef.current) {
        broadcastChannelRef.current.postMessage({
          type: 'photo:delivered',
          photo: payload,
        });
      }

      try {
        await fetch(`/api/rooms/${roomCode}/toss`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo: payload }),
        });
      } catch {
        // Local & BroadcastChannel delivery already succeeded
      }
    },
    [roomCode]
  );

  /**
   * Updates the 60fps DOM elements (full-screen photo collapse + floating camera hand orb + canvas reticle)
   */
  const renderSpatialFrame = useCallback(() => {
    const hs = handStateRef.current;
    const phase = stagePhaseRef.current;
    const canvas = overlayCanvasRef.current;

    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Draw subtle Phone Delivery Target Zone along the right edge
        const inZone = isHandInPhoneDeliveryZone(hs.pos, hs.velocity);
        ctx.save();
        ctx.strokeStyle =
          phase === 'HOLDING_IN_HAND' || phase === 'GRABBING_CLOSING'
            ? inZone
              ? 'rgba(34, 197, 94, 0.85)'
              : 'rgba(255, 255, 255, 0.28)'
            : 'rgba(255, 255, 255, 0.10)';
        ctx.lineWidth = inZone ? 3 : 1.5;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(w * 0.82, 24);
        ctx.lineTo(w * 0.82, h - 24);
        ctx.stroke();
        ctx.restore();

        // Draw motion trail when holding a grabbed photo in hand
        if (hs.trail.length > 1 && (phase === 'HOLDING_IN_HAND' || phase === 'GRABBING_CLOSING' || phase === 'DELIVERING')) {
          ctx.save();
          for (let i = 1; i < hs.trail.length; i++) {
            const p0 = hs.trail[i - 1];
            const p1 = hs.trail[i];
            const alpha = (i / hs.trail.length) * 0.65;
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(2)})`;
            ctx.lineWidth = (i / hs.trail.length) * 6;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p0.x * w, p0.y * h);
            ctx.lineTo(p1.x * w, p1.y * h);
            ctx.stroke();
          }
          ctx.restore();
        }

        // Draw skeletal hand landmarks if camera hand is detected
        if (hs.landmarks && hs.landmarks.length >= 21) {
          ctx.save();
          ctx.strokeStyle = hs.isPinched ? 'rgba(56, 189, 248, 0.85)' : 'rgba(255, 255, 255, 0.45)';
          ctx.lineWidth = 2;
          const connections = [
            [0, 1], [1, 2], [2, 3], [3, 4],
            [0, 5], [5, 6], [6, 7], [7, 8],
            [0, 9], [9, 10], [10, 11], [11, 12],
            [0, 13], [13, 14], [14, 15], [15, 16],
            [0, 17], [17, 18], [18, 19], [19, 20],
          ];
          for (const [a, b] of connections) {
            const la = hs.landmarks[a];
            const lb = hs.landmarks[b];
            ctx.beginPath();
            ctx.moveTo((1 - la.x) * w, la.y * h);
            ctx.lineTo((1 - lb.x) * w, lb.y * h);
            ctx.stroke();
          }
          ctx.restore();
        }

        // Draw Hand Tracking Reticle at smoothed hand position
        const hx = hs.pos.x * w;
        const hy = hs.pos.y * h;
        ctx.save();
        ctx.strokeStyle = hs.isPinched ? '#38BDF8' : 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = hs.isPinched ? 3 : 2;
        ctx.beginPath();
        ctx.arc(hx, hy, hs.isPinched ? 22 : 32, 0, Math.PI * 2);
        ctx.stroke();

        // Inner center point
        ctx.fillStyle = hs.isPinched ? '#38BDF8' : '#FFFFFF';
        ctx.beginPath();
        ctx.arc(hx, hy, hs.isPinched ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // Update the floating captured photo orb locked to the user's hand in camera
    const orbEl = handOrbElementRef.current;
    if (orbEl) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tx = hs.pos.x * vw;
      const ty = hs.pos.y * vh;
      const t = computeCinematicHandTransform(phase, hs.pos, hs.velocity);

      if (phase === 'GRABBING_CLOSING' || phase === 'HOLDING_IN_HAND') {
        orbEl.style.opacity = '1';
        orbEl.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) translate(-50%, -50%) perspective(900px) rotateX(${t.rotateX.toFixed(1)}deg) rotateY(${t.rotateY.toFixed(1)}deg) rotateZ(${t.rotateZ.toFixed(1)}deg) scale(1)`;
      } else if (phase === 'DELIVERING') {
        orbEl.style.opacity = '0';
        orbEl.style.transform = `translate3d(${(vw * 0.96).toFixed(0)}px, ${ty.toFixed(1)}px, 0) translate(-50%, -50%) scale(0.15)`;
      } else {
        orbEl.style.opacity = '0';
        orbEl.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) translate(-50%, -50%) scale(0.4)`;
      }
    }
  }, []);

  /**
   * Processes a single hand frame (from MediaPipe camera or mouse/touch gesture)
   */
  const processSpatialHandInput = useCallback(
    (
      rawPos: HandPoint,
      pinchDistOrBool: number | boolean,
      timestampMs: number,
      landmarks: { x: number; y: number }[] | null = null
    ) => {
      const hs = handStateRef.current;
      const dt = hs.lastTimeMs > 0 ? Math.max(1, timestampMs - hs.lastTimeMs) : 16;
      const smoothed = hs.lastTimeMs === 0 ? rawPos : smoothPoint2D(hs.pos, rawPos, 0.38);

      const vx = (smoothed.x - hs.pos.x) / dt;
      const vy = (smoothed.y - hs.pos.y) / dt;
      const velocity = {
        x: hs.velocity.x * 0.5 + vx * 0.5,
        y: hs.velocity.y * 0.5 + vy * 0.5,
      };

      const nextPinched =
        typeof pinchDistOrBool === 'boolean'
          ? pinchDistOrBool
          : evaluatePinchHysteresis(hs.isPinched, pinchDistOrBool, 0.058, 0.085);

      const nextTrail = [...hs.trail.filter((pt) => timestampMs - pt.t < 280), { x: smoothed.x, y: smoothed.y, t: timestampMs }];

      if (nextPinched !== hs.isPinched) {
        setHandPinching(nextPinched);
      }

      handStateRef.current = {
        pos: smoothed,
        velocity,
        isPinched: nextPinched,
        lastTimeMs: timestampMs,
        landmarks,
        trail: nextTrail,
      };

      const currentPhase = stagePhaseRef.current;
      const currentPhoto = activePhotoRef.current;

      if (currentPhoto) {
        // 1. If photo is open on screen and user pinches/grabs near the photo -> collapse & close photo on screen into hand!
        if (currentPhase === 'PHOTO_OPEN' && nextPinched) {
          const nearCenterPhoto =
            smoothed.x >= 0.14 && smoothed.x <= 0.86 && smoothed.y >= 0.14 && smoothed.y <= 0.86;
          if (nearCenterPhoto) {
            stagePhaseRef.current = 'HOLDING_IN_HAND';
            setStagePhase('HOLDING_IN_HAND');
            setStatusCaption(
              'Photo grabbed and closed on screen — move your hand toward the right edge (Phone Zone) to deliver!'
            );
          }
        }
        // 2. While holding the photo in camera hand: check if hand reaches the Phone Delivery Zone
        else if (currentPhase === 'HOLDING_IN_HAND' || currentPhase === 'GRABBING_CLOSING') {
          if (isHandInPhoneDeliveryZone(smoothed, velocity)) {
            stagePhaseRef.current = 'DELIVERING';
            setStagePhase('DELIVERING');
            setStatusCaption(`Delivering "${currentPhoto.title}" to your phone in full screen...`);
            deliverPhotoToPhone(currentPhoto);

            setTimeout(() => {
              stagePhaseRef.current = 'DELIVERED';
              setStagePhase('DELIVERED');
              setStatusCaption(
                `Delivered "${currentPhoto.title}" — now open in full screen on your phone.`
              );
            }, 340);
          } else if (!nextPinched) {
            // Released in the middle of the screen without reaching phone -> reopen photo smoothly on screen
            stagePhaseRef.current = 'PHOTO_OPEN';
            setStagePhase('PHOTO_OPEN');
            setStatusCaption(
              'Photo restored to screen. Pinch to grab and carry it to the right edge to send to phone.'
            );
          }
        }
      }

      renderSpatialFrame();
    },
    [deliverPhotoToPhone, renderSpatialFrame]
  );

  /**
   * Starts Full-Screen Webcam & MediaPipe HandLandmarker
   */
  const startFullScreenCamera = useCallback(async () => {
    if (cameraStreamRef.current) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      setCameraActive(true);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      // Lazy-load MediaPipe HandLandmarker
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
      } catch {
        // Pointer fallback remains active if WASM CDN is unreachable
      }

      const detectLoop = () => {
        if (!cameraStreamRef.current) return;
        const video = videoRef.current;
        if (video && video.readyState >= 2 && handLandmarkerRef.current) {
          try {
            const now = performance.now();
            const result = handLandmarkerRef.current.detectForVideo(video, now);
            if (result?.landmarks && result.landmarks.length > 0) {
              const lm = result.landmarks[0];
              const thumb = lm[4];
              const index = lm[8];
              if (thumb && index) {
                setHandDetected(true);
                const midX = 1 - (thumb.x + index.x) / 2;
                const midY = (thumb.y + index.y) / 2;
                const pinchDist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
                processSpatialHandInput({ x: midX, y: midY }, pinchDist, now, lm);
              }
            } else {
              setHandDetected(false);
            }
          } catch {
            // Keep RAF loop alive
          }
        }
        rafIdRef.current = requestAnimationFrame(detectLoop);
      };
      rafIdRef.current = requestAnimationFrame(detectLoop);
    } catch {
      // Camera permission declined or unavailable in headless browser; pointer tracking remains active
      setCameraActive(false);
    }
  }, [processSpatialHandInput]);

  const stopFullScreenCamera = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    setCameraActive(false);
    setHandDetected(false);
  }, []);

  // Automatically start full-screen camera when in Computer mode
  useEffect(() => {
    if (deviceRole === 'computer') {
      startFullScreenCamera();
    } else {
      stopFullScreenCamera();
    }
    return () => {
      stopFullScreenCamera();
    };
  }, [deviceRole, startFullScreenCamera, stopFullScreenCamera]);

  // Keep canvas sized to viewport
  useEffect(() => {
    const syncCanvasSize = () => {
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = window.innerWidth;
        overlayCanvasRef.current.height = window.innerHeight;
        renderSpatialFrame();
      }
    };
    syncCanvasSize();
    window.addEventListener('resize', syncCanvasSize);
    return () => window.removeEventListener('resize', syncCanvasSize);
  }, [renderSpatialFrame]);

  /**
   * Simulates / executes the full cinematic Grab -> Close on Screen -> Carry to Phone -> Deliver animation
   * when triggered by click or assistive button
   */
  const triggerCinematicGrabAndToss = useCallback(() => {
    const photo = activePhotoRef.current || photos[0];
    if (!photo) return;
    if (!activePhotoRef.current) {
      setActivePhoto(photo);
      activePhotoRef.current = photo;
    }

    const now = performance.now();
    // Step 1: Hand grabs at center -> photo collapses into camera hand & closes on screen
    processSpatialHandInput({ x: 0.5, y: 0.5 }, true, now);

    // Step 2: Animate hand carrying the collapsed photo orb toward the right Phone edge
    setTimeout(() => {
      processSpatialHandInput({ x: 0.68, y: 0.46 }, true, performance.now());
    }, 180);

    setTimeout(() => {
      processSpatialHandInput({ x: 0.88, y: 0.44 }, true, performance.now());
    }, 360);
  }, [photos, processSpatialHandInput]);

  const handleOpenCustomPhoto = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const newItem: SpatialPhotoItem = {
          id: `custom-${Date.now()}`,
          title: file.name.replace(/\.[^.]+$/, ''),
          subtitle: `${Math.round(file.size / 1024)} KB · Local Photo`,
          dataUrl: reader.result,
        };
        setPhotos((prev) => [newItem, ...prev]);
        setActivePhoto(newItem);
        stagePhaseRef.current = 'PHOTO_OPEN';
        setStagePhase('PHOTO_OPEN');
        setStatusCaption(`Opened "${newItem.title}" — pinch or grab with your hand to toss to phone.`);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleConnectPhoneByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = normalizeRoomCode(phoneCodeInput);
    if (cleaned.length !== 4) return;
    setRoomCode(cleaned);
    setDeviceRole('phone');
    setPhoneConnected(true);
    setShowCodeModal(false);

    try {
      const res = await fetch(`/api/rooms/${cleaned}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'phone' }),
      });
      const data = await res.json();
      if (data?.latestPhoto) {
        setDeliveredPhoto(data.latestPhoto);
        setPhoneFullScreenOpen(true);
      }
    } catch {
      // Offline/local fallback handled via BroadcastChannel
    }
  };

  // Pointer handlers on the full-screen camera stage (mouse & touch hand simulation)
  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const x = Math.max(0, Math.min(1, e.clientX / window.innerWidth));
    const y = Math.max(0, Math.min(1, e.clientY / window.innerHeight));
    const isPressed = (e.buttons & 1) === 1;
    processSpatialHandInput({ x, y }, isPressed, performance.now());
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const x = Math.max(0, Math.min(1, e.clientX / window.innerWidth));
    const y = Math.max(0, Math.min(1, e.clientY / window.innerHeight));
    processSpatialHandInput({ x, y }, true, performance.now());
  };

  const handleStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const x = Math.max(0, Math.min(1, e.clientX / window.innerWidth));
    const y = Math.max(0, Math.min(1, e.clientY / window.innerHeight));
    processSpatialHandInput({ x, y }, false, performance.now());
  };

  // ============================================================================
  // PHONE RECEIVER VIEW (Ultra-clean 4-digit code connect -> Full-screen photo)
  // ============================================================================
  if (deviceRole === 'phone') {
    return (
      <div
        data-testid="phone-receiver-screen"
        className="fixed inset-0 bg-[#090D16] text-[#F8FAFC] flex flex-col justify-between select-none overflow-hidden"
      >
        {/* Minimal Top Bar */}
        <header className="relative z-20 flex items-center justify-between gap-8 px-6 py-4 border-b border-white/10 bg-[#090D16]/90">
          <span className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0">
            Toss · Phone
          </span>
          <div className="flex items-center gap-4 text-xs text-slate-300 font-mono tabular-nums">
            <span>Code: {roomCode}</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-400 font-semibold">Connected</span>
          </div>
          <button
            type="button"
            onClick={() => setDeviceRole('computer')}
            className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-white bg-white/10 border border-white/15 rounded-lg hover:bg-white/15 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Switch to Computer
          </button>
        </header>

        {/* Full-Screen Delivered Photo View on Phone */}
        {deliveredPhoto && phoneFullScreenOpen ? (
          <main
            data-testid="phone-fullscreen-photo-viewer"
            className="fixed inset-0 z-30 bg-black flex flex-col justify-between animate-fadeIn"
          >
            <img
              src={deliveredPhoto.dataUrl}
              alt={deliveredPhoto.title}
              referrerPolicy="no-referrer"
              className="w-full h-full object-contain"
            />

            <div className="absolute inset-x-0 bottom-0 p-6 bg-black/75 border-t border-white/10 flex items-center justify-between gap-4">
              <div>
                <h1 className="text-base font-bold text-white">{deliveredPhoto.title}</h1>
                <p className="text-xs text-emerald-400 font-mono tabular-nums">
                  Delivered from Computer · Full-Screen View
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <a
                  href={deliveredPhoto.dataUrl}
                  download={`${deliveredPhoto.title}.jpg`}
                  className="min-h-[44px] px-4 py-2.5 bg-white text-slate-950 text-xs font-semibold rounded-lg flex items-center justify-center whitespace-nowrap shrink-0"
                >
                  Save Photo
                </a>
                <button
                  type="button"
                  onClick={() => setPhoneFullScreenOpen(false)}
                  className="min-h-[44px] px-4 py-2.5 bg-white/10 text-white border border-white/20 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </main>
        ) : (
          /* Phone Standby / Code Entry View */
          <main className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto w-full space-y-8">
            <div className="space-y-2">
              <p className="text-xs font-mono text-sky-400 tracking-wide">
                PHONE RECEIVER READY · CODE {roomCode}
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                Waiting for Hand Toss
              </h1>
              <p className="text-sm text-slate-400">
                Open any photo on your computer, grab it with your hand in front of the camera, and move your hand toward this phone. It will open here in full screen automatically.
              </p>
            </div>

            <form onSubmit={handleConnectPhoneByCode} className="w-full space-y-3 bg-white/5 border border-white/10 rounded-xl p-5">
              <label htmlFor="phone-room-code-input" className="block text-xs font-semibold text-slate-300">
                Paired 4-Digit Computer Code
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="phone-room-code-input"
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={phoneCodeInput}
                  onChange={(e) => setPhoneCodeInput(normalizeRoomCode(e.target.value))}
                  className="flex-1 min-h-[48px] px-4 py-2 text-center text-2xl font-mono font-bold tracking-widest bg-[#090D16] border border-white/20 rounded-lg text-white"
                  placeholder="4829"
                />
                <button
                  type="submit"
                  className="min-h-[48px] px-5 py-2 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Sync Code
                </button>
              </div>
            </form>

            {deliveredPhoto && (
              <button
                type="button"
                onClick={() => setPhoneFullScreenOpen(true)}
                className="min-h-[44px] px-5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-xs font-semibold text-white hover:bg-white/15 cursor-pointer"
              >
                Re-Open Last Delivered Photo ({deliveredPhoto.title})
              </button>
            )}
          </main>
        )}
      </div>
    );
  }

  // ============================================================================
  // COMPUTER FULL-SCREEN CAMERA & HAND TOSS STAGE
  // ============================================================================
  const photoIsOpenOnScreen = activePhoto !== null && stagePhase === 'PHOTO_OPEN';
  const photoIsHeldInHand =
    activePhoto !== null && (stagePhase === 'HOLDING_IN_HAND' || stagePhase === 'GRABBING_CLOSING');

  return (
    <div
      data-testid="computer-camera-stage"
      data-stage-phase={stagePhase}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleOpenCustomPhoto(e.dataTransfer.files);
      }}
      className="fixed inset-0 bg-[#090D16] text-white overflow-hidden select-none flex flex-col justify-between"
    >
      {/* 1. FULL-SCREEN LIVE CAMERA FEED */}
      <video
        ref={videoRef}
        muted
        playsInline
        className={`fixed inset-0 w-full h-full object-cover scale-x-[-1] pointer-events-none transition-opacity duration-300 ${
          cameraActive ? 'opacity-65' : 'opacity-0'
        }`}
      />

      {/* 2. FULL-SCREEN INTERACTIVE HAND TRACKING CANVAS OVERLAY */}
      <canvas
        ref={overlayCanvasRef}
        className="fixed inset-0 w-full h-full pointer-events-none z-10"
      />

      {/* 3. POINTER / HAND GESTURE INTERACTION SURFACE */}
      <div
        onPointerMove={handleStagePointerMove}
        onPointerDown={handleStagePointerDown}
        onPointerUp={handleStagePointerUp}
        className="fixed inset-0 z-10 cursor-grab active:cursor-grabbing touch-none"
      />

      {/* 4. ULTRA-CLEAN TOP BAR (Strictly 3 zones separated by gap-8) */}
      <header className="relative z-30 flex items-center justify-between gap-8 px-6 py-4 border-b border-white/10 bg-[#090D16]/80">
        {/* Zone 1: Brand Wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setShowCodeModal(false);
          }}
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          Toss
        </a>

        {/* Zone 2: Minimal Single-Line Navigation Links */}
        <nav aria-label="Workspace Controls" className="flex items-center gap-6 text-sm font-medium text-slate-300 overflow-x-auto">
          <button
            type="button"
            onClick={() => setShowCodeModal(true)}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 font-mono tabular-nums cursor-pointer"
          >
            Phone Code: <strong className="text-white">{roomCode}</strong>
          </button>
          <button
            type="button"
            onClick={() => setDeviceRole('phone')}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Phone View
          </button>
          <button
            type="button"
            onClick={() => setShowPipPhonePreview((v) => !v)}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {showPipPhonePreview ? 'Hide Phone Preview' : 'Show Phone Preview'}
          </button>
          <button
            type="button"
            onClick={cameraActive ? stopFullScreenCamera : startFullScreenCamera}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {cameraActive ? 'Camera Active' : 'Start Camera'}
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action (Open Any Photo from Computer) */}
        <div className="flex items-center shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              handleOpenCustomPhoto(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="min-h-[40px] px-4 py-2 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Open Photo
          </button>
        </div>
      </header>

      {/* 5. CENTER STAGE: OPEN PHOTO ON SCREEN (Collapses & closes into hand when grabbed!) */}
      <main className="relative z-20 flex-1 flex items-center justify-center p-6 pointer-events-none">
        {activePhoto && (
          <div
            ref={photoStageElementRef}
            data-testid="screen-open-photo"
            className={`relative max-w-3xl w-full transition-all duration-300 ease-out ${
              photoIsOpenOnScreen
                ? 'opacity-100 scale-100 translate-x-0'
                : stagePhase === 'HOLDING_IN_HAND' || stagePhase === 'GRABBING_CLOSING'
                ? 'opacity-0 scale-[0.18] pointer-events-none'
                : 'opacity-0 scale-50 translate-x-48 pointer-events-none'
            }`}
          >
            <div className="bg-[#0F172A] border border-white/15 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/10 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">{activePhoto.title}</span>
                  <span aria-hidden="true" className="text-slate-500">·</span>
                  <span className="text-slate-400 font-mono">{activePhoto.subtitle}</span>
                </div>
                <span className="text-sky-400 font-mono">
                  {handDetected ? 'Hand Tracking Active · Pinch to Grab' : 'Pinch or Drag Photo Toward Phone ->'}
                </span>
              </div>

              <div className="relative aspect-video bg-black overflow-hidden">
                <img
                  src={activePhoto.dataUrl}
                  alt={activePhoto.title}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
          </div>
        )}

        {/* State Banner when Photo has been Closed & Delivered to Phone */}
        {stagePhase === 'DELIVERED' && activePhoto && (
          <div
            data-testid="photo-closed-delivered-state"
            className="pointer-events-auto bg-[#0F172A]/90 border border-white/15 rounded-xl p-6 max-w-md text-center space-y-4"
          >
            <div className="text-xs font-mono text-emerald-400">
              CLOSED ON SCREEN · DELIVERED TO PHONE ({roomCode})
            </div>
            <h2 className="text-xl font-bold text-white">
              {activePhoto.title} is now open on your phone
            </h2>
            <p className="text-xs text-slate-300">
              Select another photo from the bottom bar or re-open to grab and toss again.
            </p>
            <button
              type="button"
              onClick={() => {
                stagePhaseRef.current = 'PHOTO_OPEN';
                setStagePhase('PHOTO_OPEN');
                setStatusCaption('Photo reopened on screen. Pinch or grab to toss to your phone.');
              }}
              className="min-h-[44px] px-5 py-2.5 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 cursor-pointer"
            >
              Reopen Photo on Computer
            </button>
          </div>
        )}
      </main>

      {/* 6. CINEMATIC FLOATING PHOTO CAPSULE LOCKED IN CAMERA HAND WHEN GRABBED */}
      <div
        ref={handOrbElementRef}
        data-testid="camera-hand-grabbed-orb"
        style={{ opacity: photoIsHeldInHand ? 1 : 0 }}
        className="fixed top-0 left-0 z-30 pointer-events-none w-52 transition-opacity duration-150"
      >
        {activePhoto && (
          <div className="bg-[#0F172A] border-2 border-sky-400 rounded-xl overflow-hidden p-1.5">
            <img
              src={activePhoto.dataUrl}
              alt={activePhoto.title}
              referrerPolicy="no-referrer"
              className="w-full h-28 object-cover rounded-lg"
            />
            <div className="px-2 py-1 text-[11px] font-mono text-sky-300 flex items-center justify-between">
              <span className="truncate">{activePhoto.title}</span>
              <span className="shrink-0 font-bold">IN HAND -&gt;</span>
            </div>
          </div>
        )}
      </div>

      {/* 7. RIGHT-EDGE PHONE DELIVERY BEACON */}
      <div
        aria-hidden="true"
        className={`fixed top-20 bottom-24 right-3 z-20 w-10 rounded-lg border flex items-center justify-center pointer-events-none transition-colors ${
          photoIsHeldInHand
            ? 'border-emerald-400 bg-emerald-950/50 text-emerald-300'
            : 'border-white/10 bg-white/5 text-slate-400'
        }`}
      >
        <span className="[writing-mode:vertical-rl] text-[11px] font-mono font-semibold tracking-widest whitespace-nowrap">
          PHONE DELIVERY ZONE · CODE {roomCode}
        </span>
      </div>

      {/* 8. LIVE PHONE SCREEN PREVIEW WINDOW (Shows the Phone opening the delivered photo in Full Screen!) */}
      {showPipPhonePreview && (
        <aside
          aria-label="Connected Phone Live Screen"
          data-testid="live-phone-preview-window"
          className="fixed bottom-24 right-16 z-30 w-56 sm:w-64 aspect-[9/16] bg-[#090D16] border-2 border-white/20 rounded-xl overflow-hidden flex flex-col justify-between"
        >
          <div className="px-3 py-2 bg-black/80 border-b border-white/10 flex items-center justify-between text-[11px] font-mono">
            <span className="text-white font-semibold">Phone ({roomCode})</span>
            <span className="text-emerald-400">
              {deliveredPhoto ? 'FULL SCREEN' : phoneConnected ? 'Paired' : 'Ready'}
            </span>
          </div>

          {deliveredPhoto ? (
            <div className="relative flex-1 bg-black flex flex-col justify-between overflow-hidden">
              <img
                src={deliveredPhoto.dataUrl}
                alt={`Delivered on phone: ${deliveredPhoto.title}`}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 p-2.5 bg-black/80 border-t border-white/10 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-bold text-white truncate">
                    {deliveredPhoto.title}
                  </div>
                  <div className="text-[10px] font-mono text-emerald-400">
                    Opened Full Screen
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDeviceRole('phone')}
                  className="px-2 py-1 bg-white text-slate-950 text-[10px] font-bold rounded shrink-0 cursor-pointer"
                >
                  Expand
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 p-4 flex flex-col items-center justify-center text-center space-y-2">
              <div className="text-xs font-semibold text-white">Phone Screen Standby</div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Grab the open photo on your screen and move your hand to the right edge—it will open here and on your phone in full screen.
              </p>
            </div>
          )}
        </aside>
      )}

      {/* 9. ULTRA-CLEAN BOTTOM DOCK: PHOTO SELECTOR + ONE-CLICK GRAB & TOSS */}
      <footer className="relative z-30 px-6 py-3.5 bg-[#090D16]/85 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Left: Photo Thumbnails */}
        <div className="flex items-center gap-2.5 overflow-x-auto max-w-full">
          {photos.map((item) => {
            const isSelected = activePhoto?.id === item.id && stagePhase === 'PHOTO_OPEN';
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActivePhoto(item);
                  stagePhaseRef.current = 'PHOTO_OPEN';
                  setStagePhase('PHOTO_OPEN');
                  setStatusCaption(`Opened "${item.title}" — pinch or grab with your hand to toss to phone.`);
                }}
                className={`group flex items-center gap-2.5 p-1.5 pr-3 rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isSelected
                    ? 'bg-white text-slate-950 border-white'
                    : 'bg-white/5 text-slate-200 border-white/10 hover:border-white/30'
                }`}
              >
                <img
                  src={item.dataUrl}
                  alt={item.title}
                  referrerPolicy="no-referrer"
                  className="w-10 h-7 object-cover rounded"
                />
                <span className="text-xs font-semibold">{item.title}</span>
              </button>
            );
          })}
        </div>

        {/* Center Status Caption */}
        <div
          data-testid="spatial-stage-status"
          className="text-xs text-slate-300 font-mono truncate max-w-md hidden xl:block"
        >
          {statusCaption}
        </div>

        {/* Right: Grab & Toss Action Button */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={triggerCinematicGrabAndToss}
            className="min-h-[44px] px-4 py-2 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Grab &amp; Toss to Phone
          </button>
        </div>
      </footer>

      {/* 10. CONNECT PHONE WITH 4-DIGIT CODE MODAL */}
      {showCodeModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-phone-modal-title"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-[#0F172A] border border-white/15 rounded-xl max-w-md w-full p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h2 id="connect-phone-modal-title" className="text-lg font-bold text-white">
                Connect Phone with Code
              </h2>
              <button
                type="button"
                onClick={() => setShowCodeModal(false)}
                className="min-h-[36px] px-3 py-1 bg-white/10 text-xs font-semibold text-white rounded-lg cursor-pointer"
              >
                Close
              </button>
            </div>

            <div className="text-center space-y-4">
              <p className="text-xs text-slate-300">
                Open this app on your phone and enter this 4-digit code, or scan the QR code below to connect immediately:
              </p>

              <div
                data-testid="pairing-four-digit-code"
                className="py-4 px-6 bg-[#090D16] border border-white/15 rounded-xl text-4xl font-mono font-bold tracking-[0.35em] text-white tabular-nums"
              >
                {roomCode}
              </div>

              {qrSvg && (
                <div className="w-40 h-40 mx-auto bg-white p-2.5 rounded-xl">
                  <div
                    className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                </div>
              )}
            </div>

            <div className="border-t border-white/10 pt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setDeviceRole('phone');
                  setShowCodeModal(false);
                }}
                className="flex-1 min-h-[44px] px-4 py-2 bg-white/10 border border-white/15 text-xs font-semibold text-white rounded-lg hover:bg-white/15 cursor-pointer"
              >
                Open Phone Receiver Here
              </button>
              <button
                type="button"
                onClick={() => setShowCodeModal(false)}
                className="flex-1 min-h-[44px] px-4 py-2 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
