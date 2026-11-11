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
  generateFourDigitCode,
  saveRoomInBrowserTab,
  loadRoomFromBrowserTab,
  destroyRoomInBrowserTab,
  isHandInPhoneDeliveryZone,
  computeCinematicHandTransform,
} from './utils/spatialToss';
import {
  smoothPoint2D,
  evaluatePinchHysteresis,
} from './utils/gestureMachine';
import {
  createInitialAnimeVfxState,
  triggerAnimeGrabVfx,
  triggerAnimeLaunchVfx,
  stepAndRenderAnimeVfxCanvas,
  AnimeSoundSynthesizer,
  AnimeVfxState,
} from './utils/animeVfxEngine';
import {
  EphemeralRoomClient,
  RoomMessage,
} from './utils/ephemeralWsRoom';
import alpinePhotoUrl from './assets/images/photo_alpine_architecture_1794361911541.jpg';
import desertPhotoUrl from './assets/images/photo_desert_monolith_1794361911530.jpg';
import coastalPhotoUrl from './assets/images/photo_coastal_horizon_1794361912038.jpg';

const CURATED_PHOTOS: SpatialPhotoItem[] = [
  {
    id: 'alpine-pavilion',
    title: 'Alpine_Glass_Pavilion.RAW',
    subtitle: 'Out-of-Browser Desktop Window · 3840 × 2160',
    dataUrl: alpinePhotoUrl,
  },
  {
    id: 'desert-monolith',
    title: 'Desert_Obsidian_Monolith.RAW',
    subtitle: 'Out-of-Browser Desktop Window · 3840 × 2160',
    dataUrl: desertPhotoUrl,
  },
  {
    id: 'coastal-horizon',
    title: 'Volcanic_Coastline.RAW',
    subtitle: 'Out-of-Browser Desktop Window · 3840 × 2160',
    dataUrl: coastalPhotoUrl,
  },
];

interface DeliveredPhotoPayload {
  id: string;
  title: string;
  dataUrl: string;
  timestamp: number;
}

type AppScreenMode = 'landing' | 'creator-stage' | 'joiner-phone';

export default function App() {
  const initialParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const autostart = initialParams?.get('autostart') === '1';
  const urlJoinCode = normalizeRoomCode(initialParams?.get('code') || '');

  const [screenMode, setScreenMode] = useState<AppScreenMode>(() => {
    if (autostart) return 'creator-stage';
    return 'landing';
  });

  // Room state saved exclusively in browser sessionStorage (destroyed on tab close)
  const [createdRoomCode, setCreatedRoomCode] = useState<string>(() => {
    const existing = loadRoomFromBrowserTab();
    if (existing && existing.role === 'creator') return existing.code;
    if (autostart) return '4829';
    return '';
  });
  const [joinCodeInput, setJoinCodeInput] = useState<string>(urlJoinCode);
  const [activeRoomCode, setActiveRoomCode] = useState<string>(() => {
    const existing = loadRoomFromBrowserTab();
    return existing?.code || (autostart ? '4829' : '');
  });
  const [peerConnected, setPeerConnected] = useState<boolean>(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(true);

  const [showCodeModal, setShowCodeModal] = useState<boolean>(false);
  const [showPipPhonePreview, setShowPipPhonePreview] = useState<boolean>(true);
  const [qrSvg, setQrSvg] = useState<string>('');
  const [sfxMuted, setSfxMuted] = useState<boolean>(false);

  // Out-of-Browser Laptop Screen Capture (getDisplayMedia + Pop-out OS Window)
  const [desktopStreamActive, setDesktopStreamActive] = useState<boolean>(false);
  const [desktopSurfaceName, setDesktopSurfaceName] = useState<string>('Desktop OS Viewer');
  const [externalPipWindowOpen, setExternalPipWindowOpen] = useState<boolean>(false);

  // Photo Library & Open Photo on Laptop Screen
  const [photos, setPhotos] = useState<SpatialPhotoItem[]>(CURATED_PHOTOS);
  const [activePhoto, setActivePhoto] = useState<SpatialPhotoItem | null>(CURATED_PHOTOS[0]);
  const [stagePhase, setStagePhase] = useState<SpatialStagePhase>('PHOTO_OPEN');
  const [animeActionBanner, setAnimeActionBanner] = useState<string | null>(null);
  const [statusCaption, setStatusCaption] = useState<string>(
    'Hand Tracking Ready — Pinch/Grab the open laptop photo to rip it into your hand with Anime Spatial VFX.'
  );

  // Delivered Photo on Phone (Opens in Full Screen on Phone)
  const [deliveredPhoto, setDeliveredPhoto] = useState<DeliveredPhotoPayload | null>(null);
  const [phoneFullScreenOpen, setPhoneFullScreenOpen] = useState<boolean>(false);

  // Full-Screen Camera & Hand Tracking state
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [handDetected, setHandDetected] = useState<boolean>(false);

  // Refs for Ephemeral WebSocket Room Client, 60fps per-frame camera, desktop capture, and Anime VFX loop
  const roomClientRef = useRef<EphemeralRoomClient | null>(null);
  const createdRoomCodeRef = useRef<string>(createdRoomCode);
  createdRoomCodeRef.current = createdRoomCode;
  const activeRoomCodeRef = useRef<string>(activeRoomCode);
  activeRoomCodeRef.current = activeRoomCode;
  const screenModeRef = useRef<AppScreenMode>(screenMode);
  screenModeRef.current = screenMode;

  const stageRootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const desktopVideoRef = useRef<HTMLVideoElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const handOrbElementRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const desktopStreamRef = useRef<MediaStream | null>(null);
  const externalPipWindowRef = useRef<Window | null>(null);
  const handLandmarkerRef = useRef<any>(null);
  const vfxRafIdRef = useRef<number | null>(null);
  const cameraRafIdRef = useRef<number | null>(null);
  const sfxRef = useRef<AnimeSoundSynthesizer>(new AnimeSoundSynthesizer());

  const animeVfxStateRef = useRef<AnimeVfxState>(createInitialAnimeVfxState());

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

  // Generate QR code whenever a room is created in the browser
  useEffect(() => {
    const codeForQr = createdRoomCode || activeRoomCode;
    if (!codeForQr) {
      setQrSvg('');
      return;
    }
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    const pairUrl = `${origin}/?code=${codeForQr}`;
    QRCode.toString(pairUrl, {
      type: 'svg',
      margin: 1,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    })
      .then((svg) => setQrSvg(svg))
      .catch(() => {});
  }, [createdRoomCode, activeRoomCode]);

  /**
   * Establishes the serverless Ephemeral WebSocket Room Client (works on Vercel, mobile LTE, and localhost
   * without ever spamming failed `/ws` requests) and destroys the browser-stored room immediately on tab close.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleRoomMessage = (msg: RoomMessage) => {
      const type = msg.type;
      const saved = loadRoomFromBrowserTab();
      const myHostedCode = (saved?.role === 'creator' ? saved.code : '') || createdRoomCodeRef.current;

      if (type === 'peer_join_request') {
        if (myHostedCode && msg.code === myHostedCode) {
          setPeerConnected(true);
          saveRoomInBrowserTab({
            code: myHostedCode,
            role: 'creator',
            createdAt: saved?.createdAt || Date.now(),
            peerConnected: true,
          });
          roomClientRef.current?.sendRoomEvent({
            type: 'join_accepted',
            code: myHostedCode,
          });
          setActiveRoomCode(myHostedCode);
          setScreenMode('creator-stage');
        }
      } else if (type === 'join_accepted') {
        if (msg.code === activeRoomCodeRef.current) {
          setRoomError(null);
          setPeerConnected(true);
          setActiveRoomCode(msg.code);
          saveRoomInBrowserTab({
            code: msg.code,
            role: 'joiner',
            createdAt: Date.now(),
            peerConnected: true,
          });
          setScreenMode('joiner-phone');
        }
      } else if (type === 'room_error') {
        if (!peerConnected) {
          setRoomError(msg.message || 'Room not found or host tab was closed.');
        }
      } else if (type === 'photo_toss' && msg.photo) {
        if (!activeRoomCodeRef.current || msg.code === activeRoomCodeRef.current) {
          const incoming = msg.photo as DeliveredPhotoPayload;
          setDeliveredPhoto(incoming);
          setPhoneFullScreenOpen(true);
          setPeerConnected(true);
        }
      } else if (type === 'room_destroyed') {
        if (!activeRoomCodeRef.current || msg.code === activeRoomCodeRef.current) {
          destroyRoomInBrowserTab();
          setCreatedRoomCode('');
          setActiveRoomCode('');
          setPeerConnected(false);
          setDeliveredPhoto(null);
          setPhoneFullScreenOpen(false);
          setScreenMode('landing');
          setRoomError(msg.reason || 'Host browser tab closed — room was destroyed.');
        }
      } else if (type === 'peer_left') {
        setPeerConnected(false);
      }
    };

    const client = new EphemeralRoomClient(handleRoomMessage, (connected) => {
      setWsConnected(connected);
    });
    roomClientRef.current = client;
    client.start();

    // If this browser tab already created a room in sessionStorage, re-register live host topic
    const existingRoom = loadRoomFromBrowserTab();
    if (existingRoom && existingRoom.role === 'creator' && existingRoom.code) {
      client.hostRoom(existingRoom.code);
    }

    // Destroy room in browser storage & notify peer as soon as the host tab is closed
    const handleTabUnload = () => {
      const saved = loadRoomFromBrowserTab();
      const codeToDestroy = (saved?.role === 'creator' ? saved.code : '') || createdRoomCodeRef.current;
      destroyRoomInBrowserTab();
      if (codeToDestroy) {
        client.destroyRoom(codeToDestroy);
      }
    };

    window.addEventListener('beforeunload', handleTabUnload);
    window.addEventListener('pagehide', handleTabUnload);

    return () => {
      window.removeEventListener('beforeunload', handleTabUnload);
      window.removeEventListener('pagehide', handleTabUnload);
      client.stop();
    };
  }, []);

  /**
   * Creates a new 4-digit Room in the browser (sessionStorage) and registers host on WebSocket
   */
  const handleCreateRoom = () => {
    setRoomError(null);
    const newCode = generateFourDigitCode();
    setCreatedRoomCode(newCode);
    createdRoomCodeRef.current = newCode;
    setActiveRoomCode(newCode);
    activeRoomCodeRef.current = newCode;
    setPeerConnected(false);

    saveRoomInBrowserTab({
      code: newCode,
      role: 'creator',
      createdAt: Date.now(),
      peerConnected: false,
    });

    roomClientRef.current?.hostRoom(newCode);
  };

  /**
   * Destroys the currently active browser room and returns all connected devices to the Landing Page
   */
  const handleDestroyRoomNow = () => {
    const code = createdRoomCode || activeRoomCode;
    destroyRoomInBrowserTab();
    if (code) {
      roomClientRef.current?.destroyRoom(code);
    }
    setCreatedRoomCode('');
    setActiveRoomCode('');
    setPeerConnected(false);
    setDeliveredPhoto(null);
    setPhoneFullScreenOpen(false);
    setScreenMode('landing');
  };

  /**
   * Joins an existing room created by another device's browser tab via WebSocket
   */
  const handleJoinRoomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = normalizeRoomCode(joinCodeInput);
    if (cleaned.length !== 4) {
      setRoomError('Enter the 4-digit code shown on the Create Room device.');
      return;
    }
    setRoomError(null);
    setActiveRoomCode(cleaned);
    activeRoomCodeRef.current = cleaned;

    // If joining the room created in this same tab (for single-machine testing), accept immediately
    if (createdRoomCode && cleaned === createdRoomCode) {
      setPeerConnected(true);
      setScreenMode('joiner-phone');
      return;
    }

    roomClientRef.current?.joinRoom(cleaned);
  };

  /**
   * Captures a high-resolution snapshot from the live out-of-browser Laptop Screen stream (getDisplayMedia)
   */
  const snapFrameFromDesktopStreamIfActive = useCallback((): SpatialPhotoItem | null => {
    const dVideo = desktopVideoRef.current;
    if (!desktopStreamRef.current || !dVideo || dVideo.readyState < 2) {
      return activePhotoRef.current;
    }
    try {
      const vw = dVideo.videoWidth || 1280;
      const vh = dVideo.videoHeight || 720;
      const offscreen = document.createElement('canvas');
      offscreen.width = vw;
      offscreen.height = vh;
      const ctx = offscreen.getContext('2d');
      if (!ctx) return activePhotoRef.current;
      ctx.drawImage(dVideo, 0, 0, vw, vh);
      const dataUrl = offscreen.toDataURL('image/jpeg', 0.88);
      const snapped: SpatialPhotoItem = {
        id: `desktop-snap-${Date.now()}`,
        title: `Laptop_Screen_Capture.RAW`,
        subtitle: `Out-of-Browser OS Capture (${vw}×${vh})`,
        dataUrl,
      };
      activePhotoRef.current = snapped;
      setActivePhoto(snapped);
      return snapped;
    } catch {
      return activePhotoRef.current;
    }
  }, []);

  /**
   * Converts any image URL into a self-contained base64 JPEG data URL so it streams
   * across WebSockets between any two devices (e.g. Laptop on Wi-Fi to Phone on 5G).
   */
  const ensurePortableDataUrl = useCallback(async (srcUrl: string): Promise<string> => {
    if (srcUrl.startsWith('data:image/')) {
      return srcUrl;
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const maxDim = 1280;
          const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1280, img.naturalHeight || 720));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round((img.naturalWidth || 1280) * scale);
          canvas.height = Math.round((img.naturalHeight || 720) * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(srcUrl);
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.84));
        } catch {
          resolve(srcUrl);
        }
      };
      img.onerror = () => resolve(srcUrl);
      img.src = srcUrl;
    });
  }, []);

  /**
   * Streams the grabbed photo directly over WebSocket (and BroadcastChannel) to the joined phone tab
   * without saving anything on the server.
   */
  const deliverPhotoToPhone = useCallback(
    (photo: SpatialPhotoItem) => {
      const code = activeRoomCodeRef.current || createdRoomCodeRef.current || '4829';
      const immediatePayload: DeliveredPhotoPayload = {
        id: `${photo.id}-${Date.now()}`,
        title: photo.title,
        dataUrl: photo.dataUrl,
        timestamp: Date.now(),
      };

      setDeliveredPhoto(immediatePayload);
      setPhoneFullScreenOpen(true);

      ensurePortableDataUrl(photo.dataUrl).then((portableDataUrl) => {
        const networkPayload: DeliveredPhotoPayload = {
          ...immediatePayload,
          dataUrl: portableDataUrl,
        };
        roomClientRef.current?.sendRoomEvent({
          type: 'photo_toss',
          code,
          photo: networkPayload,
        });
      });
    },
    [ensurePortableDataUrl]
  );

  /**
   * Continuous 60fps Anime Action VFX + Hand Energy Core Render Loop
   */
  useEffect(() => {
    if (screenMode !== 'creator-stage') return;

    let running = true;
    const renderLoop = () => {
      if (!running) return;
      const hs = handStateRef.current;
      const phase = stagePhaseRef.current;
      const vfx = animeVfxStateRef.current;
      const canvas = overlayCanvasRef.current;

      if (canvas) {
        if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);

          const isHolding = phase === 'HOLDING_IN_HAND' || phase === 'GRABBING_CLOSING';
          stepAndRenderAnimeVfxCanvas(ctx, w, h, vfx, hs.pos, isHolding, hs.isPinched);

          if (hs.trail.length > 1 && (isHolding || phase === 'DELIVERING')) {
            ctx.save();
            for (let i = 1; i < hs.trail.length; i++) {
              const p0 = hs.trail[i - 1];
              const p1 = hs.trail[i];
              const ratio = i / hs.trail.length;
              ctx.strokeStyle =
                i % 2 === 0
                  ? `rgba(56, 189, 248, ${(ratio * 0.75).toFixed(2)})`
                  : `rgba(244, 63, 94, ${(ratio * 0.75).toFixed(2)})`;
              ctx.lineWidth = ratio * 10;
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(p0.x * w, p0.y * h);
              ctx.lineTo(p1.x * w, p1.y * h);
              ctx.stroke();
            }
            ctx.restore();
          }

          if (hs.landmarks && hs.landmarks.length >= 21) {
            ctx.save();
            ctx.strokeStyle = hs.isPinched ? '#38BDF8' : 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 2.5;
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

          const hx = hs.pos.x * w;
          const hy = hs.pos.y * h;
          ctx.save();
          ctx.strokeStyle = hs.isPinched ? '#F43F5E' : '#38BDF8';
          ctx.lineWidth = hs.isPinched ? 3 : 2;
          ctx.beginPath();
          ctx.arc(hx, hy, hs.isPinched ? 24 : 34, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.arc(hx, hy, hs.isPinched ? 6 : 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      if (stageRootRef.current) {
        if (vfx.screenShakeIntensity > 0.5) {
          const sx = (Math.random() - 0.5) * vfx.screenShakeIntensity;
          const sy = (Math.random() - 0.5) * vfx.screenShakeIntensity;
          stageRootRef.current.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
        } else {
          stageRootRef.current.style.transform = 'translate3d(0px, 0px, 0px)';
        }
      }

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
          orbEl.style.transform = `translate3d(${(vw * 0.98).toFixed(0)}px, ${ty.toFixed(1)}px, 0) translate(-50%, -50%) scale(0.1)`;
        } else {
          orbEl.style.opacity = '0';
          orbEl.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) translate(-50%, -50%) scale(0.3)`;
        }
      }

      vfxRafIdRef.current = requestAnimationFrame(renderLoop);
    };

    vfxRafIdRef.current = requestAnimationFrame(renderLoop);
    return () => {
      running = false;
      if (vfxRafIdRef.current) cancelAnimationFrame(vfxRafIdRef.current);
    };
  }, [screenMode]);

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
      const smoothed = hs.lastTimeMs === 0 ? rawPos : smoothPoint2D(hs.pos, rawPos, 0.42);

      const vx = (smoothed.x - hs.pos.x) / dt;
      const vy = (smoothed.y - hs.pos.y) / dt;
      const velocity = {
        x: hs.velocity.x * 0.45 + vx * 0.55,
        y: hs.velocity.y * 0.45 + vy * 0.55,
      };

      const nextPinched =
        typeof pinchDistOrBool === 'boolean'
          ? pinchDistOrBool
          : evaluatePinchHysteresis(hs.isPinched, pinchDistOrBool, 0.058, 0.085);

      const nextTrail = [
        ...hs.trail.filter((pt) => timestampMs - pt.t < 320),
        { x: smoothed.x, y: smoothed.y, t: timestampMs },
      ];

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
        if (currentPhase === 'PHOTO_OPEN' && nextPinched) {
          const nearCenterPhoto =
            smoothed.x >= 0.12 && smoothed.x <= 0.88 && smoothed.y >= 0.12 && smoothed.y <= 0.88;
          if (nearCenterPhoto) {
            const captured = snapFrameFromDesktopStreamIfActive() || currentPhoto;

            if (externalPipWindowRef.current) {
              try {
                externalPipWindowRef.current.close();
              } catch {}
              externalPipWindowRef.current = null;
              setExternalPipWindowOpen(false);
            }

            const vw = window.innerWidth;
            const vh = window.innerHeight;
            animeVfxStateRef.current = triggerAnimeGrabVfx(
              animeVfxStateRef.current,
              smoothed.x * vw,
              smoothed.y * vh,
              vw * 0.46,
              vh * 0.48
            );
            sfxRef.current.playGrabImpact();

            stagePhaseRef.current = 'HOLDING_IN_HAND';
            setStagePhase('HOLDING_IN_HAND');
            setAnimeActionBanner('DIMENSIONAL GRAB // PHOTO LOCKED IN HAND');
            setStatusCaption(
              `Ripped "${captured.title}" off laptop screen — thrust hand toward right Phone Zone to fire!`
            );
          }
        } else if (currentPhase === 'HOLDING_IN_HAND' || currentPhase === 'GRABBING_CLOSING') {
          if (isHandInPhoneDeliveryZone(smoothed, velocity)) {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            animeVfxStateRef.current = triggerAnimeLaunchVfx(
              animeVfxStateRef.current,
              smoothed.x * vw,
              smoothed.y * vh,
              vw * 0.96,
              smoothed.y * vh
            );
            sfxRef.current.playSonicLaunch();

            stagePhaseRef.current = 'DELIVERING';
            setStagePhase('DELIVERING');
            setAnimeActionBanner('SPATIAL FLASH // DELIVERED TO PHONE');
            setStatusCaption(
              `Fired "${currentPhoto.title}" over WebSocket to Phone (${activeRoomCodeRef.current || createdRoomCodeRef.current}) in Full Screen!`
            );
            deliverPhotoToPhone(currentPhoto);

            setTimeout(() => {
              stagePhaseRef.current = 'DELIVERED';
              setStagePhase('DELIVERED');
              setTimeout(() => setAnimeActionBanner(null), 1600);
            }, 340);
          } else if (!nextPinched) {
            stagePhaseRef.current = 'PHOTO_OPEN';
            setStagePhase('PHOTO_OPEN');
            setAnimeActionBanner(null);
            setStatusCaption(
              'Photo restored to laptop screen. Pinch/grab and thrust toward the right Phone edge to launch.'
            );
          }
        }
      }
    },
    [snapFrameFromDesktopStreamIfActive, deliverPhotoToPhone]
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
        // Pointer fallback remains active
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
        cameraRafIdRef.current = requestAnimationFrame(detectLoop);
      };
      cameraRafIdRef.current = requestAnimationFrame(detectLoop);
    } catch {
      setCameraActive(false);
    }
  }, [processSpatialHandInput]);

  const stopFullScreenCamera = useCallback(() => {
    if (cameraRafIdRef.current) {
      cancelAnimationFrame(cameraRafIdRef.current);
      cameraRafIdRef.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    setCameraActive(false);
    setHandDetected(false);
  }, []);

  const startOutOfBrowserScreenLink = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' } as MediaTrackConstraints,
        audio: false,
      });
      desktopStreamRef.current = stream;
      setDesktopStreamActive(true);
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() as MediaTrackSettings & { displaySurface?: string };
      setDesktopSurfaceName(
        settings?.displaySurface === 'window'
          ? 'External OS App Window'
          : settings?.displaySurface === 'monitor'
          ? 'Full Laptop Desktop Screen'
          : 'Live Laptop Screen Stream'
      );

      if (desktopVideoRef.current) {
        desktopVideoRef.current.srcObject = stream;
        await desktopVideoRef.current.play().catch(() => {});
      }

      stagePhaseRef.current = 'PHOTO_OPEN';
      setStagePhase('PHOTO_OPEN');
      setStatusCaption(
        'Linked Out-of-Browser Laptop Screen! Open any photo on your laptop, then grab in front of the camera.'
      );

      track?.addEventListener('ended', () => {
        stopOutOfBrowserScreenLink();
      });
    } catch {
      setStatusCaption(
        'Using Floating OS Desktop Viewer Layer (Select "Link Laptop Screen" anytime to capture external OS apps).'
      );
    }
  };

  const stopOutOfBrowserScreenLink = () => {
    if (desktopStreamRef.current) {
      desktopStreamRef.current.getTracks().forEach((t) => t.stop());
      desktopStreamRef.current = null;
    }
    setDesktopStreamActive(false);
  };

  const popOutFloatingOsPhotoWindow = async () => {
    const current = activePhotoRef.current || photos[0];
    if (!current) return;

    const docPip = (
      window as unknown as {
        documentPictureInPicture?: {
          requestWindow: (opts: { width: number; height: number }) => Promise<Window>;
        };
      }
    ).documentPictureInPicture;

    if (docPip) {
      try {
        const pipWin = await docPip.requestWindow({ width: 680, height: 440 });
        externalPipWindowRef.current = pipWin;
        setExternalPipWindowOpen(true);
        pipWin.document.title = `${current.title} — OS Photo Viewer`;
        pipWin.document.body.style.margin = '0';
        pipWin.document.body.style.background = '#090D16';
        pipWin.document.body.style.display = 'flex';
        pipWin.document.body.style.alignItems = 'center';
        pipWin.document.body.style.justifyContent = 'center';
        pipWin.document.body.style.height = '100vh';
        const img = pipWin.document.createElement('img');
        img.src = current.dataUrl;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        pipWin.document.body.appendChild(img);

        pipWin.addEventListener('pagehide', () => {
          externalPipWindowRef.current = null;
          setExternalPipWindowOpen(false);
        });
        return;
      } catch {
        // Fallback below
      }
    }
    stagePhaseRef.current = 'PHOTO_OPEN';
    setStagePhase('PHOTO_OPEN');
  };

  useEffect(() => {
    if (screenMode === 'creator-stage') {
      startFullScreenCamera();
    } else {
      stopFullScreenCamera();
    }
    return () => {
      stopFullScreenCamera();
    };
  }, [screenMode, startFullScreenCamera, stopFullScreenCamera]);

  const triggerAnimeGrabAndLaunch = useCallback(() => {
    const photo = activePhotoRef.current || photos[0];
    if (!photo) return;
    if (!activePhotoRef.current) {
      setActivePhoto(photo);
      activePhotoRef.current = photo;
    }
    if (stagePhaseRef.current !== 'PHOTO_OPEN') {
      stagePhaseRef.current = 'PHOTO_OPEN';
      setStagePhase('PHOTO_OPEN');
    }

    const now = performance.now();
    processSpatialHandInput({ x: 0.46, y: 0.48 }, true, now);

    setTimeout(() => {
      processSpatialHandInput({ x: 0.64, y: 0.45 }, true, performance.now());
    }, 240);

    setTimeout(() => {
      processSpatialHandInput({ x: 0.88, y: 0.42 }, true, performance.now());
    }, 520);
  }, [photos, processSpatialHandInput]);

  const handleOpenCustomPhoto = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const newItem: SpatialPhotoItem = {
          id: `custom-${Date.now()}`,
          title: file.name,
          subtitle: `Out-of-Browser Desktop Layer · ${Math.round(file.size / 1024)} KB`,
          dataUrl: reader.result,
        };
        setPhotos((prev) => [newItem, ...prev]);
        setActivePhoto(newItem);
        activePhotoRef.current = newItem;
        stagePhaseRef.current = 'PHOTO_OPEN';
        setStagePhase('PHOTO_OPEN');
        setStatusCaption(
          `Opened "${newItem.title}" on laptop screen — pinch/grab with your hand for Anime Spatial Toss!`
        );
      }
    };
    reader.readAsDataURL(file);
  };

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
  // 1. LANDING PAGE: CREATE ROOM vs JOIN ROOM (Browser-Only Room Storage over WebSocket)
  // ============================================================================
  if (screenMode === 'landing') {
    return (
      <div
        data-testid="landing-room-screen"
        className="min-h-screen bg-[#090D16] text-white flex flex-col justify-between select-none"
      >
        {/* Minimal 3-Zone Top Bar */}
        <header className="flex items-center justify-between gap-8 px-6 md:px-10 py-4 border-b border-white/10">
          <a
            href="#top"
            onClick={(e) => e.preventDefault()}
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            Toss
          </a>
          <div className="flex items-center gap-4 text-xs font-mono text-slate-400">
            <span>WebSocket Relay: {wsConnected ? 'CONNECTED' : 'CONNECTING'}</span>
            <span aria-hidden="true">·</span>
            <span>Storage: Browser Tab Only (Zero Server Storage)</span>
          </div>
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleCreateRoom}
              className="min-h-[40px] px-4 py-2 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Create Room
            </button>
          </div>
        </header>

        <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-10 flex flex-col justify-center space-y-8">
          <div className="max-w-2xl space-y-2">
            <div className="text-xs font-mono font-bold text-sky-400 tracking-widest">
              SPATIAL HAND GRAB · EPHEMERAL WEBSOCKET ROOMS
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
              Create a room on your laptop. Join with the code on your phone.
            </h1>
            <p className="text-sm text-slate-400">
              Rooms live strictly inside your browser tab via sessionStorage and stream directly over WebSocket. As soon as you close the tab, the room is destroyed.
            </p>
          </div>

          {roomError && (
            <div
              role="alert"
              className="bg-rose-950/60 border border-rose-500/60 rounded-xl px-4 py-3 text-xs font-mono text-rose-200 flex items-center justify-between gap-4"
            >
              <span>{roomError}</span>
              <button
                type="button"
                onClick={() => setRoomError(null)}
                className="px-2.5 py-1 bg-white/10 rounded text-white font-semibold cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Two-Column Create Room / Join Room Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
            {/* Column 1: Create Room (Laptop Host) */}
            <section
              aria-labelledby="create-room-heading"
              className="bg-[#0F172A] border border-white/15 rounded-xl p-6 flex flex-col justify-between space-y-6"
            >
              <div className="space-y-3">
                <div className="text-xs font-mono text-sky-400">01 · LAPTOP / CAMERA HOST</div>
                <h2 id="create-room-heading" className="text-xl font-bold text-white">
                  Create Room
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Generate a 4-digit room code stored only in this browser tab. Once connected, open any photo on your laptop screen, grab it with your hand in front of the camera, and fire it to your phone.
                </p>

                {createdRoomCode ? (
                  <div className="pt-2 space-y-4">
                    <div className="p-4 bg-[#090D16] border border-sky-400/50 rounded-xl text-center space-y-2">
                      <div className="text-[11px] font-mono text-slate-400">
                        SHARE THIS 4-DIGIT ROOM CODE WITH YOUR PHONE
                      </div>
                      <div
                        data-testid="created-room-code-display"
                        className="text-4xl font-mono font-bold tracking-[0.35em] text-white tabular-nums"
                      >
                        {createdRoomCode}
                      </div>
                      <div className="text-[11px] font-mono text-emerald-400">
                        {peerConnected
                          ? 'Second device joined! Ready for Spatial Toss'
                          : 'Waiting for second device to join via code...'}
                      </div>
                    </div>

                    {qrSvg && (
                      <div className="flex items-center gap-4 bg-[#090D16] border border-white/10 rounded-xl p-3">
                        <div
                          className="w-20 h-20 bg-white p-1.5 rounded-lg shrink-0 [&>svg]:w-full [&>svg]:h-full"
                          dangerouslySetInnerHTML={{ __html: qrSvg }}
                        />
                        <div className="text-xs text-slate-300 space-y-1">
                          <div className="font-semibold text-white">Instant QR Join</div>
                          <p className="text-[11px] text-slate-400">
                            Scan with your phone camera to prefill code <strong className="text-white font-mono">{createdRoomCode}</strong>.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-6 bg-[#090D16] border border-white/10 rounded-xl text-center text-xs text-slate-400">
                    Click &ldquo;Create Room&rdquo; below to generate a browser-stored 4-digit room code.
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                {!createdRoomCode ? (
                  <button
                    type="button"
                    onClick={handleCreateRoom}
                    className="w-full min-h-[48px] px-5 py-3 bg-white text-slate-950 text-sm font-bold rounded-lg hover:bg-slate-200 transition-colors cursor-pointer"
                  >
                    Create Room
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveRoomCode(createdRoomCode);
                        setScreenMode('creator-stage');
                      }}
                      className="flex-1 min-h-[48px] px-5 py-3 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      Open Full-Screen Camera Stage
                    </button>
                    <button
                      type="button"
                      onClick={handleDestroyRoomNow}
                      className="min-h-[48px] px-4 py-3 bg-rose-950/80 border border-rose-500/50 text-rose-200 text-xs font-semibold rounded-lg hover:bg-rose-900/80 whitespace-nowrap cursor-pointer"
                    >
                      Destroy Room
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* Column 2: Join Room (Phone Receiver) */}
            <section
              aria-labelledby="join-room-heading"
              className="bg-[#0F172A] border border-white/15 rounded-xl p-6 flex flex-col justify-between space-y-6"
            >
              <div className="space-y-3">
                <div className="text-xs font-mono text-emerald-400">02 · PHONE / RECEIVER DEVICE</div>
                <h2 id="join-room-heading" className="text-xl font-bold text-white">
                  Join Room
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Enter the 4-digit code shown on the host device. When the host grabs a photo and thrusts it toward your phone, it automatically opens in full screen.
                </p>

                <form id="join-room-form" onSubmit={handleJoinRoomSubmit} className="pt-2 space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor="join-room-code-input" className="block text-xs font-semibold text-slate-300">
                      Enter 4-Digit Room Code
                    </label>
                    <input
                      id="join-room-code-input"
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={joinCodeInput}
                      onChange={(e) => setJoinCodeInput(normalizeRoomCode(e.target.value))}
                      placeholder="0000"
                      className="w-full min-h-[56px] px-4 py-3 text-center text-3xl font-mono font-bold tracking-[0.35em] bg-[#090D16] border border-white/20 rounded-xl text-white focus:outline-2 focus:outline-sky-400 tabular-nums"
                    />
                  </div>
                </form>
              </div>

              <button
                type="submit"
                form="join-room-form"
                className="w-full min-h-[48px] px-5 py-3 bg-sky-400 text-slate-950 text-sm font-bold rounded-lg hover:bg-sky-300 transition-colors cursor-pointer"
              >
                Join Room with Code
              </button>
            </section>
          </div>
        </main>

        <footer className="px-6 md:px-10 py-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-400">
          <span>Ephemeral Browser-Saved Room Architecture · WebSocket Direct Stream</span>
          <span className="font-mono">Closing the host tab immediately destroys the room</span>
        </footer>
      </div>
    );
  }

  // ============================================================================
  // 2. JOINER PHONE RECEIVER VIEW (Connected via 4-Digit Room Code -> Opens Full Screen)
  // ============================================================================
  if (screenMode === 'joiner-phone') {
    const displayCode = activeRoomCode || joinCodeInput || createdRoomCode;
    return (
      <div
        data-testid="phone-receiver-screen"
        className="fixed inset-0 bg-[#090D16] text-[#F8FAFC] flex flex-col justify-between select-none overflow-hidden"
      >
        <header className="relative z-20 flex items-center justify-between gap-8 px-6 py-4 border-b border-white/10 bg-[#090D16]/90">
          <span className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0">
            Toss · Phone Receiver
          </span>
          <div className="flex items-center gap-4 text-xs text-slate-300 font-mono tabular-nums">
            <span>Room: {displayCode}</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-400 font-semibold">WebSocket Live</span>
          </div>
          <button
            type="button"
            onClick={() => setScreenMode('landing')}
            className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-white bg-white/10 border border-white/15 rounded-lg hover:bg-white/15 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Leave Room
          </button>
        </header>

        {deliveredPhoto && phoneFullScreenOpen ? (
          <main
            data-testid="phone-fullscreen-photo-viewer"
            className="fixed inset-0 z-30 bg-black flex flex-col justify-between"
          >
            <img
              src={deliveredPhoto.dataUrl}
              alt={deliveredPhoto.title}
              referrerPolicy="no-referrer"
              className="w-full h-full object-contain"
            />

            <div className="absolute inset-x-0 bottom-0 p-6 bg-black/80 border-t border-sky-400/40 flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] font-mono text-sky-400 font-bold tracking-wider">
                  SPATIAL IMPACT // FULL-SCREEN DELIVERY (ROOM {displayCode})
                </div>
                <h1 className="text-base font-bold text-white">{deliveredPhoto.title}</h1>
              </div>
              <div className="flex items-center gap-2.5">
                <a
                  href={deliveredPhoto.dataUrl}
                  download={`${deliveredPhoto.title}.jpg`}
                  className="min-h-[44px] px-4 py-2.5 bg-white text-slate-950 text-xs font-bold rounded-lg flex items-center justify-center whitespace-nowrap shrink-0"
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
          <main className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto w-full space-y-6">
            <div className="space-y-2">
              <p className="text-xs font-mono text-sky-400 tracking-wide">
                JOINED ROOM {displayCode} · WAITING FOR ANIME TOSS
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                Phone Connected to Room {displayCode}
              </h1>
              <p className="text-sm text-slate-400">
                Open any photo on the host laptop screen, grab it in front of the camera, and thrust your hand toward this phone—it will slam open in full screen here automatically.
              </p>
            </div>
          </main>
        )}
      </div>
    );
  }

  // ============================================================================
  // 3. CREATOR STAGE: FULL-SCREEN CAMERA + OUT-OF-BROWSER OS PHOTO + ANIME ACTION VFX
  // ============================================================================
  const currentRoomCode = createdRoomCode || activeRoomCode || '4829';
  const photoIsOpenOnScreen = activePhoto !== null && stagePhase === 'PHOTO_OPEN';
  const photoIsHeldInHand =
    activePhoto !== null && (stagePhase === 'HOLDING_IN_HAND' || stagePhase === 'GRABBING_CLOSING');

  return (
    <div
      ref={stageRootRef}
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

      {/* Hidden video element holding the live Out-of-Browser getDisplayMedia OS screen stream */}
      <video ref={desktopVideoRef} muted playsInline className="hidden" />

      {/* 2. FULL-SCREEN 60FPS ANIME ACTION VFX CANVAS */}
      <canvas
        ref={overlayCanvasRef}
        className="fixed inset-0 w-full h-full pointer-events-none z-20"
      />

      {/* 3. POINTER / HAND GESTURE INTERACTION SURFACE */}
      <div
        onPointerMove={handleStagePointerMove}
        onPointerDown={handleStagePointerDown}
        onPointerUp={handleStagePointerUp}
        className="fixed inset-0 z-10 cursor-grab active:cursor-grabbing touch-none"
      />

      {/* 4. ULTRA-CLEAN TOP BAR (Strictly 3 zones separated by gap-8) */}
      <header className="relative z-30 flex items-center justify-between gap-8 px-6 py-3.5 border-b border-white/10 bg-[#090D16]/85">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setScreenMode('landing');
          }}
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          Toss
        </a>

        <nav aria-label="Workspace Controls" className="flex items-center gap-6 text-sm font-medium text-slate-300 overflow-x-auto">
          <button
            type="button"
            onClick={() => setShowCodeModal(true)}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 font-mono tabular-nums cursor-pointer"
          >
            Room Code: <strong className="text-white">{currentRoomCode}</strong>{' '}
            <span className="text-emerald-400">({peerConnected ? 'Peer Joined' : 'Waiting'})</span>
          </button>
          <button
            type="button"
            onClick={desktopStreamActive ? stopOutOfBrowserScreenLink : startOutOfBrowserScreenLink}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {desktopStreamActive ? `Linked: ${desktopSurfaceName}` : 'Link Laptop Screen (Out-of-Browser)'}
          </button>
          <button
            type="button"
            onClick={popOutFloatingOsPhotoWindow}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {externalPipWindowOpen ? 'OS Window Active' : 'Pop Out OS Window'}
          </button>
          <button
            type="button"
            onClick={handleDestroyRoomNow}
            className="text-rose-400 hover:text-rose-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Destroy Room
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !sfxMuted;
              setSfxMuted(next);
              sfxRef.current.muted = next;
            }}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {sfxMuted ? 'SFX: Muted' : 'SFX: Anime Audio'}
          </button>
        </nav>

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

      {/* ANIME ACTION CALLOUT BANNER */}
      {animeActionBanner && (
        <div
          data-testid="anime-action-callout"
          className="fixed top-20 left-1/2 -translate-x-1/2 z-40 pointer-events-none px-5 py-2 bg-[#090D16] border-2 border-sky-400 rounded-lg text-xs font-mono font-bold tracking-widest text-sky-300 whitespace-nowrap"
        >
          {animeActionBanner}
        </div>
      )}

      {/* 5. CENTER STAGE: FLOATING OUT-OF-BROWSER OS DESKTOP PHOTO VIEWER WINDOW */}
      <main className="relative z-15 flex-1 flex items-center justify-center p-6 pointer-events-none">
        {activePhoto && (
          <div
            data-testid="screen-open-photo"
            className={`relative max-w-3xl w-full transition-all duration-200 ease-out ${
              photoIsOpenOnScreen
                ? 'opacity-100 scale-100'
                : 'opacity-0 scale-0 pointer-events-none'
            }`}
          >
            <div className="bg-[#111827] border-2 border-white/25 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-[#090D16] border-b border-white/15 flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5" aria-hidden="true">
                    <span className="w-3 h-3 rounded-sm bg-rose-500 inline-block" />
                    <span className="w-3 h-3 rounded-sm bg-amber-400 inline-block" />
                    <span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" />
                  </div>
                  <span className="font-mono font-bold text-white">{activePhoto.title}</span>
                  <span aria-hidden="true" className="text-slate-500">·</span>
                  <span className="text-slate-400 font-mono text-[11px]">
                    {desktopStreamActive
                      ? `Live Desktop Capture (${desktopSurfaceName})`
                      : 'OS Desktop Photo Viewer (Out-of-Browser Layer)'}
                  </span>
                </div>
                <span className="text-sky-400 font-mono font-semibold text-[11px]">
                  {handDetected ? 'HAND LOCKED · PINCH TO SHATTER & GRAB' : 'PINCH / GRAB TO RIP OUT OF SCREEN'}
                </span>
              </div>

              <div className="relative aspect-video bg-black overflow-hidden">
                {desktopStreamActive ? (
                  <DesktopStreamMirrorCanvas videoRef={desktopVideoRef} />
                ) : (
                  <img
                    src={activePhoto.dataUrl}
                    alt={activePhoto.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {stagePhase === 'DELIVERED' && activePhoto && (
          <div
            data-testid="photo-closed-delivered-state"
            className="pointer-events-auto bg-[#0F172A]/95 border-2 border-sky-400/60 rounded-xl p-6 max-w-md text-center space-y-4"
          >
            <div className="text-xs font-mono font-bold text-sky-400 tracking-wider">
              OS PHOTO WINDOW CLOSED · DELIVERED TO ROOM ({currentRoomCode})
            </div>
            <h2 className="text-xl font-bold text-white">
              {activePhoto.title} slammed open on your phone
            </h2>
            <p className="text-xs text-slate-300">
              Streamed directly over WebSocket. Close this browser tab at any time to immediately destroy Room {currentRoomCode}.
            </p>
            <button
              type="button"
              onClick={() => {
                stagePhaseRef.current = 'PHOTO_OPEN';
                setStagePhase('PHOTO_OPEN');
                setStatusCaption('OS Photo Window restored on laptop screen — grab with your hand to launch again.');
              }}
              className="min-h-[44px] px-5 py-2.5 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 cursor-pointer"
            >
              Reopen Photo on Laptop Screen
            </button>
          </div>
        )}
      </main>

      {/* 6. ANIME ENERGY SPHERE + CAPTURED PHOTO LOCKED IN CAMERA HAND WHEN GRABBED */}
      <div
        ref={handOrbElementRef}
        data-testid="camera-hand-grabbed-orb"
        style={{ opacity: photoIsHeldInHand ? 1 : 0 }}
        className="fixed top-0 left-0 z-30 pointer-events-none w-56 transition-opacity duration-75"
      >
        {activePhoto && (
          <div className="bg-[#090D16] border-2 border-rose-500 rounded-xl overflow-hidden p-1.5">
            <img
              src={activePhoto.dataUrl}
              alt={activePhoto.title}
              referrerPolicy="no-referrer"
              className="w-full h-28 object-cover rounded-lg border border-sky-400"
            />
            <div className="px-2 py-1 text-[11px] font-mono text-sky-300 flex items-center justify-between">
              <span className="truncate font-bold">{activePhoto.title}</span>
              <span className="shrink-0 text-rose-400 font-bold">ANIME LOCK -&gt;</span>
            </div>
          </div>
        )}
      </div>

      {/* 7. RIGHT-EDGE PHONE DELIVERY WARP GATE */}
      <div
        aria-hidden="true"
        className={`fixed top-20 bottom-24 right-3 z-20 w-10 rounded-lg border-2 flex items-center justify-center pointer-events-none transition-colors ${
          photoIsHeldInHand
            ? 'border-sky-400 bg-sky-950/60 text-white'
            : 'border-white/15 bg-white/5 text-slate-400'
        }`}
      >
        <span className="[writing-mode:vertical-rl] text-[11px] font-mono font-bold tracking-widest whitespace-nowrap">
          PHONE WARP GATE · ROOM {currentRoomCode}
        </span>
      </div>

      {/* 8. LIVE PHONE SCREEN PREVIEW WINDOW */}
      {showPipPhonePreview && (
        <aside
          aria-label="Connected Phone Live Screen"
          data-testid="live-phone-preview-window"
          className="fixed bottom-24 right-16 z-30 w-56 sm:w-64 aspect-[9/16] bg-[#090D16] border-2 border-white/25 rounded-xl overflow-hidden flex flex-col justify-between"
        >
          <div className="px-3 py-2 bg-black/90 border-b border-white/15 flex items-center justify-between text-[11px] font-mono">
            <span className="text-white font-bold">Phone (Room {currentRoomCode})</span>
            <button
              type="button"
              onClick={() => setShowPipPhonePreview(false)}
              className="text-slate-400 hover:text-white cursor-pointer"
            >
              Hide
            </button>
          </div>

          {deliveredPhoto ? (
            <div className="relative flex-1 bg-black flex flex-col justify-between overflow-hidden">
              <img
                src={deliveredPhoto.dataUrl}
                alt={`Delivered on phone: ${deliveredPhoto.title}`}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 p-2.5 bg-black/85 border-t border-sky-400/40 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-bold text-white truncate">
                    {deliveredPhoto.title}
                  </div>
                  <div className="text-[10px] font-mono text-sky-400 font-bold">
                    FULL-SCREEN IMPACT
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setScreenMode('joiner-phone')}
                  className="px-2 py-1 bg-white text-slate-950 text-[10px] font-bold rounded shrink-0 cursor-pointer"
                >
                  Expand
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 p-4 flex flex-col items-center justify-center text-center space-y-2">
              <div className="text-xs font-bold text-white">Phone Standby</div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Grab the photo on your laptop screen—watch it shatter into your hand and slam into full screen here.
              </p>
            </div>
          )}
        </aside>
      )}

      {/* 9. BOTTOM DOCK: PHOTO SELECTOR + ANIME GRAB & LAUNCH TRIGGER */}
      <footer className="relative z-30 px-6 py-3.5 bg-[#090D16]/90 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 overflow-x-auto max-w-full">
          {photos.map((item) => {
            const isSelected = activePhoto?.id === item.id && stagePhase === 'PHOTO_OPEN';
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActivePhoto(item);
                  activePhotoRef.current = item;
                  stagePhaseRef.current = 'PHOTO_OPEN';
                  setStagePhase('PHOTO_OPEN');
                  setStatusCaption(`Opened "${item.title}" in OS Desktop Layer — grab with your hand!`);
                }}
                className={`flex items-center gap-2.5 p-1.5 pr-3 rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
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

        <div
          data-testid="spatial-stage-status"
          className="text-xs text-slate-300 font-mono truncate max-w-md hidden xl:block"
        >
          {statusCaption}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={triggerAnimeGrabAndLaunch}
            className="min-h-[44px] px-5 py-2 bg-white text-slate-950 text-xs font-bold rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Anime Grab &amp; Fire to Phone
          </button>
        </div>
      </footer>

      {/* 10. ROOM CODE MODAL */}
      {showCodeModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-phone-modal-title"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        >
          <div className="bg-[#0F172A] border border-white/20 rounded-xl max-w-md w-full p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h2 id="connect-phone-modal-title" className="text-lg font-bold text-white">
                Browser-Saved Room Code
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
                Saved only in this browser tab (sessionStorage). Enter this code under &ldquo;Join Room&rdquo; on your phone:
              </p>

              <div
                data-testid="pairing-four-digit-code"
                className="py-4 px-6 bg-[#090D16] border border-white/15 rounded-xl text-4xl font-mono font-bold tracking-[0.35em] text-white tabular-nums"
              >
                {currentRoomCode}
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
                onClick={handleDestroyRoomNow}
                className="flex-1 min-h-[44px] px-4 py-2 bg-rose-950 border border-rose-500/40 text-xs font-semibold text-rose-200 rounded-lg hover:bg-rose-900 cursor-pointer"
              >
                Destroy Room
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

const DesktopStreamMirrorCanvas: React.FC<{ videoRef: React.RefObject<HTMLVideoElement | null> }> = ({
  videoRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let active = true;
    const draw = () => {
      if (!active) return;
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.readyState >= 2) {
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.drawImage(v, 0, 0, c.width, c.height);
        }
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
    return () => {
      active = false;
    };
  }, [videoRef]);

  return <canvas ref={canvasRef} width={960} height={540} className="w-full h-full object-contain" />;
};
