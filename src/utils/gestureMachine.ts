/**
 * Phase 4 & Phase 6 Gesture State Machine, EMA Smoothing, Pinch Hysteresis,
 * Perspective Tilt, and Calibrated Edge Velocity Throw Logic.
 * Kept 100% pure and decoupled from React state so per-frame updates run at 60fps without re-renders.
 */

export type CalibratedEdge = 'top' | 'right' | 'bottom' | 'left';

export type GesturePhase =
  | 'IDLE'
  | 'HOVER'
  | 'PINCH_GRAB'
  | 'DRAG'
  | 'RELEASE_THROW'
  | 'CANCEL';

export interface Point2D {
  x: number; // Normalized [0..1] in Stage coordinates
  y: number; // Normalized [0..1] in Stage coordinates
}

export interface RectNormalized {
  x: number; // [0..1]
  y: number; // [0..1]
  width: number; // [0..1]
  height: number; // [0..1]
}

export interface GestureFrameTracker {
  phase: GesturePhase;
  smoothedPos: Point2D;
  velocity: Point2D; // Normalized units per millisecond
  isPinched: boolean;
  grabOffset: Point2D;
  regionOrigin: Point2D;
  regionOffset: Point2D; // Delta in normalized units from origin
  lastTimestampMs: number;
}

export const EMA_SMOOTHING_ALPHA = 0.35;
export const PINCH_ENTER_THRESHOLD = 0.052; // Normalized distance between thumb tip (4) and index tip (8)
export const PINCH_EXIT_THRESHOLD = 0.078;  // Hysteresis band prevents rapid pinch/unpinch flicker
export const THROW_VELOCITY_THRESHOLD = 0.00055; // Normalized stage units per ms toward calibrated edge
export const THROW_EDGE_ZONE_THRESHOLD = 0.16; // Within 16% of the calibrated target edge

export function createInitialGestureTracker(regionRect: RectNormalized): GestureFrameTracker {
  return {
    phase: 'IDLE',
    smoothedPos: { x: 0.5, y: 0.5 },
    velocity: { x: 0, y: 0 },
    isPinched: false,
    grabOffset: { x: 0, y: 0 },
    regionOrigin: { x: regionRect.x, y: regionRect.y },
    regionOffset: { x: 0, y: 0 },
    lastTimestampMs: 0,
  };
}

export function smoothPoint2D(
  prev: Point2D,
  raw: Point2D,
  alpha = EMA_SMOOTHING_ALPHA
): Point2D {
  const clampedAlpha = Math.max(0.05, Math.min(1, alpha));
  return {
    x: prev.x + clampedAlpha * (raw.x - prev.x),
    y: prev.y + clampedAlpha * (raw.y - prev.y),
  };
}

export function evaluatePinchHysteresis(
  currentlyPinched: boolean,
  thumbIndexDistance: number,
  enterThreshold = PINCH_ENTER_THRESHOLD,
  exitThreshold = PINCH_EXIT_THRESHOLD
): boolean {
  if (currentlyPinched) {
    return thumbIndexDistance <= exitThreshold;
  }
  return thumbIndexDistance <= enterThreshold;
}

export function isPointInsideRect(pt: Point2D, rect: RectNormalized, padding = 0.02): boolean {
  return (
    pt.x >= rect.x - padding &&
    pt.x <= rect.x + rect.width + padding &&
    pt.y >= rect.y - padding &&
    pt.y <= rect.y + rect.height + padding
  );
}

export function evaluateEdgeThrow(
  cursorPos: Point2D,
  velocity: Point2D,
  calibratedEdge: CalibratedEdge
): { shouldThrow: boolean; directionalSpeed: number; nearEdge: boolean } {
  let directionalSpeed = 0;
  let nearEdge = false;

  switch (calibratedEdge) {
    case 'top':
      directionalSpeed = -velocity.y;
      nearEdge = cursorPos.y <= THROW_EDGE_ZONE_THRESHOLD;
      break;
    case 'right':
      directionalSpeed = velocity.x;
      nearEdge = cursorPos.x >= 1 - THROW_EDGE_ZONE_THRESHOLD;
      break;
    case 'bottom':
      directionalSpeed = velocity.y;
      nearEdge = cursorPos.y >= 1 - THROW_EDGE_ZONE_THRESHOLD;
      break;
    case 'left':
      directionalSpeed = -velocity.x;
      nearEdge = cursorPos.x <= THROW_EDGE_ZONE_THRESHOLD;
      break;
  }

  const shouldThrow =
    directionalSpeed >= THROW_VELOCITY_THRESHOLD ||
    (nearEdge && directionalSpeed >= -0.0001);

  return {
    shouldThrow,
    directionalSpeed,
    nearEdge,
  };
}

export function computePerspectiveTilt(
  velocity: Point2D,
  regionOffset: Point2D,
  reducedMotion: boolean
): { rotateXDeg: number; rotateYDeg: number; scale: number } {
  if (reducedMotion) {
    return { rotateXDeg: 0, rotateYDeg: 0, scale: 1 };
  }
  const maxTilt = 14;
  const vxContribution = velocity.x * 9000 + regionOffset.x * 16;
  const vyContribution = -velocity.y * 9000 - regionOffset.y * 16;

  const rotateYDeg = Math.max(-maxTilt, Math.min(maxTilt, vxContribution));
  const rotateXDeg = Math.max(-maxTilt, Math.min(maxTilt, vyContribution));

  return {
    rotateXDeg: Number(rotateXDeg.toFixed(2)),
    rotateYDeg: Number(rotateYDeg.toFixed(2)),
    scale: 1.03,
  };
}

export function stepGestureMachine(
  tracker: GestureFrameTracker,
  rawPos: Point2D,
  pinchDistanceOrActive: number | boolean,
  regionRect: RectNormalized,
  calibratedEdge: CalibratedEdge,
  timestampMs: number
): {
  next: GestureFrameTracker;
  phaseChanged: boolean;
  triggeredThrow: boolean;
  triggeredCancel: boolean;
} {
  const dt = tracker.lastTimestampMs > 0 ? Math.max(1, timestampMs - tracker.lastTimestampMs) : 16;
  const nextSmoothed =
    tracker.lastTimestampMs === 0 ? rawPos : smoothPoint2D(tracker.smoothedPos, rawPos);

  const instVx = (nextSmoothed.x - tracker.smoothedPos.x) / dt;
  const instVy = (nextSmoothed.y - tracker.smoothedPos.y) / dt;

  const nextVelocity = {
    x: tracker.velocity.x * 0.55 + instVx * 0.45,
    y: tracker.velocity.y * 0.55 + instVy * 0.45,
  };

  const nextPinched =
    typeof pinchDistanceOrActive === 'boolean'
      ? pinchDistanceOrActive
      : evaluatePinchHysteresis(tracker.isPinched, pinchDistanceOrActive);

  let nextPhase: GesturePhase = tracker.phase;
  let grabOffset = tracker.grabOffset;
  let regionOffset = tracker.regionOffset;
  let triggeredThrow = false;
  let triggeredCancel = false;

  const activeRect: RectNormalized = {
    x: regionRect.x + tracker.regionOffset.x,
    y: regionRect.y + tracker.regionOffset.y,
    width: regionRect.width,
    height: regionRect.height,
  };

  const inside = isPointInsideRect(nextSmoothed, activeRect);

  if (tracker.phase === 'IDLE' || tracker.phase === 'CANCEL' || tracker.phase === 'RELEASE_THROW') {
    regionOffset = { x: 0, y: 0 };
    if (inside && nextPinched) {
      nextPhase = 'PINCH_GRAB';
      grabOffset = {
        x: nextSmoothed.x - regionRect.x,
        y: nextSmoothed.y - regionRect.y,
      };
    } else if (inside) {
      nextPhase = 'HOVER';
    } else {
      nextPhase = 'IDLE';
    }
  } else if (tracker.phase === 'HOVER') {
    if (nextPinched && inside) {
      nextPhase = 'PINCH_GRAB';
      grabOffset = {
        x: nextSmoothed.x - regionRect.x,
        y: nextSmoothed.y - regionRect.y,
      };
    } else if (!inside) {
      nextPhase = 'IDLE';
    }
  } else if (tracker.phase === 'PINCH_GRAB' || tracker.phase === 'DRAG') {
    if (nextPinched) {
      const dx = nextSmoothed.x - grabOffset.x - regionRect.x;
      const dy = nextSmoothed.y - grabOffset.y - regionRect.y;
      regionOffset = { x: dx, y: dy };
      const movedDist = Math.hypot(dx, dy);
      nextPhase = movedDist > 0.012 ? 'DRAG' : 'PINCH_GRAB';
    } else {
      // Released pinch: evaluate whether velocity/position throws toward calibrated edge
      const evalResult = evaluateEdgeThrow(nextSmoothed, nextVelocity, calibratedEdge);
      if (evalResult.shouldThrow) {
        nextPhase = 'RELEASE_THROW';
        triggeredThrow = true;
      } else {
        nextPhase = 'CANCEL';
        regionOffset = { x: 0, y: 0 };
        triggeredCancel = true;
      }
    }
  }

  const next: GestureFrameTracker = {
    phase: nextPhase,
    smoothedPos: nextSmoothed,
    velocity: nextVelocity,
    isPinched: nextPinched,
    grabOffset,
    regionOrigin: { x: regionRect.x, y: regionRect.y },
    regionOffset,
    lastTimestampMs: timestampMs,
  };

  return {
    next,
    phaseChanged: nextPhase !== tracker.phase,
    triggeredThrow,
    triggeredCancel,
  };
}
