import { HandPoint } from './spatialToss';

export interface DimensionalShard {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  angle: number;
  vAngle: number;
  color: string;
  progress: number; // 0 -> 1 (1 = absorbed into hand core)
}

export interface ShockwaveRing {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  alpha: number;
  lineWidth: number;
}

export interface SlashBeam {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  alpha: number;
  width: number;
}

export interface AnimeVfxState {
  impactFramesRemaining: number;
  screenShakeIntensity: number;
  auraRotation: number;
  shards: DimensionalShard[];
  rings: ShockwaveRing[];
  beams: SlashBeam[];
  afterimages: { x: number; y: number; scale: number; alpha: number }[];
}

export function createInitialAnimeVfxState(): AnimeVfxState {
  return {
    impactFramesRemaining: 0,
    screenShakeIntensity: 0,
    auraRotation: 0,
    shards: [],
    rings: [],
    beams: [],
    afterimages: [],
  };
}

const ANIME_SHARD_COLORS = ['#38BDF8', '#F43F5E', '#FACC15', '#FFFFFF', '#A855F7'];

/**
 * Spawns 32 dimensional shards from the center laptop screen area that rip outward
 * and spiral into the user's hand when a grab is triggered.
 */
export function createDimensionalShards(
  originX: number,
  originY: number,
  count = 32
): DimensionalShard[] {
  const shards: DimensionalShard[] = [];
  for (let i = 0; i < count; i++) {
    const spreadAngle = (Math.PI * 2 * i) / count;
    const radiusOffset = 40 + (i % 5) * 35;
    const sx = originX + Math.cos(spreadAngle) * radiusOffset;
    const sy = originY + Math.sin(spreadAngle) * (radiusOffset * 0.65);

    shards.push({
      id: i,
      startX: sx,
      startY: sy,
      x: sx,
      y: sy,
      vx: Math.cos(spreadAngle) * (6 + (i % 4) * 3),
      vy: Math.sin(spreadAngle) * (6 + (i % 4) * 3),
      size: 10 + (i % 4) * 7,
      angle: spreadAngle,
      vAngle: (i % 2 === 0 ? 1 : -1) * 0.18,
      color: ANIME_SHARD_COLORS[i % ANIME_SHARD_COLORS.length],
      progress: 0,
    });
  }
  return shards;
}

/**
 * Steps all dimensional shards toward the user's hand coordinates (targetX, targetY)
 * with anime vortex swirl physics.
 */
export function stepShardsTowardHand(
  shards: DimensionalShard[],
  targetX: number,
  targetY: number,
  dtScale = 1
): DimensionalShard[] {
  const next: DimensionalShard[] = [];
  for (const s of shards) {
    const nextProgress = Math.min(1, s.progress + 0.048 * dtScale);
    if (nextProgress >= 1) continue;

    // Swirl tangent + strong pull toward hand core
    const dx = targetX - s.x;
    const dy = targetY - s.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const pullStrength = 0.22 + nextProgress * 0.35;

    // Tangential swirl vector
    const swirlX = -dy / dist;
    const swirlY = dx / dist;

    const nx = s.x + dx * pullStrength + swirlX * (1 - nextProgress) * 14;
    const ny = s.y + dy * pullStrength + swirlY * (1 - nextProgress) * 14;

    next.push({
      ...s,
      x: nx,
      y: ny,
      angle: s.angle + s.vAngle * dtScale,
      progress: nextProgress,
    });
  }
  return next;
}

/**
 * Generates jagged anime lightning bolt segments between two points.
 */
export function generateLightningPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  segments = 8,
  jitter = 22,
  seed = Math.random()
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [{ x: x1, y: y1 }];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const bx = x1 + (x2 - x1) * t;
    const by = y1 + (y2 - y1) * t;
    const pseudo = Math.sin(seed * 97 + i * 31.7);
    const perpX = -(y2 - y1);
    const perpY = x2 - x1;
    const len = Math.max(1, Math.hypot(perpX, perpY));
    pts.push({
      x: bx + (perpX / len) * pseudo * jitter,
      y: by + (perpY / len) * pseudo * jitter,
    });
  }
  pts.push({ x: x2, y: y2 });
  return pts;
}

/**
 * Triggers the Anime Grab Impact VFX (Impact frames + dimensional shatter + shockwave rings)
 */
export function triggerAnimeGrabVfx(
  state: AnimeVfxState,
  handPixelX: number,
  handPixelY: number,
  screenCenterX: number,
  screenCenterY: number
): AnimeVfxState {
  return {
    ...state,
    impactFramesRemaining: 3, // 3 frames of manga B&W/crimson flash
    screenShakeIntensity: 18,
    shards: createDimensionalShards(screenCenterX, screenCenterY, 36),
    rings: [
      ...state.rings,
      {
        x: screenCenterX,
        y: screenCenterY,
        radius: 20,
        maxRadius: 520,
        color: '#38BDF8',
        alpha: 1,
        lineWidth: 8,
      },
      {
        x: handPixelX,
        y: handPixelY,
        radius: 10,
        maxRadius: 280,
        color: '#F43F5E',
        alpha: 1,
        lineWidth: 6,
      },
    ],
  };
}

/**
 * Triggers the Anime God-Speed Launch Beam when throwing the grabbed photo toward the phone
 */
export function triggerAnimeLaunchVfx(
  state: AnimeVfxState,
  handPixelX: number,
  handPixelY: number,
  targetPixelX: number,
  targetPixelY: number
): AnimeVfxState {
  return {
    ...state,
    impactFramesRemaining: 4,
    screenShakeIntensity: 26,
    rings: [
      ...state.rings,
      {
        x: handPixelX,
        y: handPixelY,
        radius: 15,
        maxRadius: 650,
        color: '#FACC15',
        alpha: 1,
        lineWidth: 10,
      },
      {
        x: targetPixelX,
        y: targetPixelY,
        radius: 10,
        maxRadius: 480,
        color: '#38BDF8',
        alpha: 1,
        lineWidth: 12,
      },
    ],
    beams: [
      ...state.beams,
      {
        startX: handPixelX,
        startY: handPixelY,
        endX: targetPixelX,
        endY: targetPixelY,
        alpha: 1,
        width: 54,
      },
    ],
  };
}

/**
 * Renders the full 60fps Anime Action VFX layer onto the overlay canvas:
 * - Manga Impact Frames (High-contrast flash + converging Shūchūsen speed lines)
 * - Dimensional Photo Shards spiraling into the user's hand
 * - Rotating Anime Energy Seal + Cracking Lightning Bolts around the hand
 * - God-Speed Sonic Boom Rings & Launch Slash Beam toward the phone
 */
export function stepAndRenderAnimeVfxCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: AnimeVfxState,
  hand: HandPoint,
  isHoldingPhoto: boolean,
  isPinching: boolean
): void {
  const hx = hand.x * width;
  const hy = hand.y * height;

  state.auraRotation += 0.065;

  // 1. MANGA IMPACT FRAMES (Black/White & Crimson High-Contrast Flash on Grab / Launch)
  if (state.impactFramesRemaining > 0) {
    const isOdd = state.impactFramesRemaining % 2 === 1;
    ctx.save();
    ctx.fillStyle = isOdd ? 'rgba(255, 255, 255, 0.88)' : 'rgba(9, 13, 22, 0.92)';
    ctx.fillRect(0, 0, width, height);

    // Draw 72 fierce converging manga speed lines centered on the hand
    ctx.strokeStyle = isOdd ? '#090D16' : '#F43F5E';
    const numLines = 72;
    for (let i = 0; i < numLines; i++) {
      const angle = (Math.PI * 2 * i) / numLines;
      const innerR = 65 + (i % 5) * 28;
      const outerR = Math.max(width, height) * 1.2;
      ctx.lineWidth = (i % 3) + 1.5;
      ctx.beginPath();
      ctx.moveTo(hx + Math.cos(angle) * innerR, hy + Math.sin(angle) * innerR);
      ctx.lineTo(hx + Math.cos(angle) * outerR, hy + Math.sin(angle) * outerR);
      ctx.stroke();
    }
    ctx.restore();
    state.impactFramesRemaining -= 1;
  }

  // 2. RADIAL ANIME SPEED LINES (Shūchūsen) around screen edges while holding photo in hand
  if (isHoldingPhoto) {
    ctx.save();
    const numEdgeLines = 56;
    const tNow = performance.now() * 0.01;
    for (let i = 0; i < numEdgeLines; i++) {
      const angle = (Math.PI * 2 * i) / numEdgeLines + Math.sin(tNow + i) * 0.01;
      const innerR = 140 + ((i * 19) % 90);
      const outerR = Math.max(width, height) * 0.95;
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = i % 4 === 0 ? 2.5 : 1;
      ctx.beginPath();
      ctx.moveTo(hx + Math.cos(angle) * innerR, hy + Math.sin(angle) * innerR);
      ctx.lineTo(hx + Math.cos(angle) * outerR, hy + Math.sin(angle) * outerR);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3. STEP & DRAW DIMENSIONAL SHARDS SPIRALING INTO HAND
  if (state.shards.length > 0) {
    state.shards = stepShardsTowardHand(state.shards, hx, hy, 1);
    ctx.save();
    for (const s of state.shards) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.angle);
      ctx.fillStyle = s.color;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      const sz = s.size * (1 - s.progress * 0.6);
      ctx.beginPath();
      ctx.moveTo(0, -sz);
      ctx.lineTo(sz * 0.85, sz * 0.7);
      ctx.lineTo(-sz * 0.85, sz * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // 4. ANIME ENERGY CORE, ROTATING GEOMETRIC SEAL & LIGHTNING BOLTS AROUND HAND
  if (isHoldingPhoto || isPinching) {
    ctx.save();
    ctx.translate(hx, hy);

    // Outer rotating geometric seal ring
    ctx.save();
    ctx.rotate(state.auraRotation);
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([14, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, 88, 0, Math.PI * 2);
    ctx.stroke();

    // Inscribed anime dimensional square
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-62, -62, 124, 124);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
    ctx.strokeRect(-62, -62, 124, 124);
    ctx.restore();

    // Inner counter-rotating core ring
    ctx.save();
    ctx.rotate(-state.auraRotation * 1.6);
    ctx.strokeStyle = '#FACC15';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 48, 0, Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    // Procedural crackling anime lightning arcs around hand
    ctx.save();
    const numBolts = isHoldingPhoto ? 5 : 3;
    for (let b = 0; b < numBolts; b++) {
      const a1 = state.auraRotation * 2 + (b * Math.PI * 2) / numBolts;
      const a2 = a1 + 1.1;
      const r1 = 36 + (b % 2) * 30;
      const r2 = 96 + (b % 3) * 25;
      const pts = generateLightningPoints(
        hx + Math.cos(a1) * r1,
        hy + Math.sin(a1) * r1,
        hx + Math.cos(a2) * r2,
        hy + Math.sin(a2) * r2,
        7,
        18,
        performance.now() * 0.01 + b
      );
      ctx.strokeStyle = b % 2 === 0 ? '#38BDF8' : '#F43F5E';
      ctx.lineWidth = b % 2 === 0 ? 3 : 2;
      ctx.beginPath();
      pts.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  // 5. EXPANDING SONIC BOOM SHOCKWAVE RINGS
  if (state.rings.length > 0) {
    const remainingRings: ShockwaveRing[] = [];
    ctx.save();
    for (const ring of state.rings) {
      ring.radius += (ring.maxRadius - ring.radius) * 0.16 + 8;
      ring.alpha *= 0.88;
      if (ring.alpha > 0.04 && ring.radius < ring.maxRadius) {
        ctx.strokeStyle = ring.color;
        ctx.globalAlpha = ring.alpha;
        ctx.lineWidth = ring.lineWidth * ring.alpha;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
        ctx.stroke();
        remainingRings.push(ring);
      }
    }
    ctx.restore();
    state.rings = remainingRings;
  }

  // 6. GOD-SPEED LAUNCH SLASH BEAM TOWARD PHONE
  if (state.beams.length > 0) {
    const remainingBeams: SlashBeam[] = [];
    ctx.save();
    for (const beam of state.beams) {
      beam.alpha *= 0.84;
      beam.width *= 0.92;
      if (beam.alpha > 0.04) {
        ctx.globalAlpha = beam.alpha;
        // Outer cyan/crimson energy sheath
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = beam.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(beam.startX, beam.startY);
        ctx.lineTo(beam.endX, beam.endY);
        ctx.stroke();

        // Inner pure white anime beam core
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = beam.width * 0.42;
        ctx.beginPath();
        ctx.moveTo(beam.startX, beam.startY);
        ctx.lineTo(beam.endX, beam.endY);
        ctx.stroke();

        remainingBeams.push(beam);
      }
    }
    ctx.restore();
    state.beams = remainingBeams;
  }

  // Decay screen shake
  if (state.screenShakeIntensity > 0.2) {
    state.screenShakeIntensity *= 0.82;
  } else {
    state.screenShakeIntensity = 0;
  }
}

/**
 * Pure Web Audio API Anime Action SFX Synthesizer (Zero external audio files required)
 */
export class AnimeSoundSynthesizer {
  private ctx: AudioContext | null = null;
  public muted = false;

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Plays an anime dimensional-rip + sub-bass impact drop when grabbing a photo
   */
  public playGrabImpact() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      // Sub-bass impact drop (160Hz -> 32Hz)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(170, now);
      osc.frequency.exponentialRampToValueAtTime(32, now + 0.32);

      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.36);

      // High-frequency anime crystalline chime / electric snap
      const snapOsc = ctx.createOscillator();
      const snapGain = ctx.createGain();
      snapOsc.type = 'triangle';
      snapOsc.frequency.setValueAtTime(920, now);
      snapOsc.frequency.exponentialRampToValueAtTime(2400, now + 0.14);

      snapGain.gain.setValueAtTime(0.2, now);
      snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

      snapOsc.connect(snapGain);
      snapGain.connect(ctx.destination);
      snapOsc.start(now);
      snapOsc.stop(now + 0.17);
    } catch {
      // Ignore audio policy restriction
    }
  }

  /**
   * Plays a sonic-boom anime beam launch when shooting the photo into the phone
   */
  public playSonicLaunch() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(240, now);
      osc.frequency.exponentialRampToValueAtTime(1480, now + 0.18);
      osc.frequency.exponentialRampToValueAtTime(85, now + 0.45);

      gain.gain.setValueAtTime(0.38, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.5);
    } catch {
      // Ignore audio policy restriction
    }
  }
}
