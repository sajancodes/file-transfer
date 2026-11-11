export interface SpatialPhotoItem {
  id: string;
  title: string;
  subtitle: string;
  dataUrl: string;
}

export type SpatialStagePhase =
  | 'PHOTO_OPEN'       // Photo is open on screen; hand is open/hovering
  | 'GRABBING_CLOSING' // Hand just pinched: photo collapses into hand in camera and closes on screen
  | 'HOLDING_IN_HAND'  // Photo is closed on screen and held as a glowing spatial card inside the camera hand
  | 'DELIVERING'       // Hand moved toward phone edge: cinematic launch into phone
  | 'DELIVERED';       // Photo delivered to phone and opened in full screen on phone

export interface HandPoint {
  x: number; // Normalized [0..1]
  y: number; // Normalized [0..1]
}

export function normalizeRoomCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 4);
}

export function generateFourDigitCode(seed = Math.random()): string {
  const num = Math.floor(1000 + seed * 9000);
  return String(Math.min(9999, Math.max(1000, num)));
}

/**
 * Determines whether the user's hand holding the grabbed photo has reached
 * the Phone Delivery Zone (within 18% of the right, top, or bottom edge, or released with velocity toward edge).
 */
export function isHandInPhoneDeliveryZone(
  hand: HandPoint,
  velocity: HandPoint = { x: 0, y: 0 }
): boolean {
  const nearRightEdge = hand.x >= 0.80;
  const nearTopEdge = hand.y <= 0.16;
  const nearBottomEdge = hand.y >= 0.84;
  const fastThrowRight = velocity.x >= 0.00065 && hand.x >= 0.62;
  const fastThrowUp = velocity.y <= -0.00065 && hand.y <= 0.38;

  return nearRightEdge || nearTopEdge || nearBottomEdge || fastThrowRight || fastThrowUp;
}

/**
 * Computes the 3D cinematic transform for the photo as it collapses from the center of the screen
 * into the user's pinched hand in the camera view.
 */
export function computeCinematicHandTransform(
  phase: SpatialStagePhase,
  hand: HandPoint,
  velocity: HandPoint
): {
  scale: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  opacity: number;
} {
  const tiltX = Math.max(-22, Math.min(22, -velocity.y * 14000));
  const tiltY = Math.max(-22, Math.min(22, velocity.x * 14000));
  const tiltZ = Math.max(-15, Math.min(15, (hand.x - 0.5) * 24));

  switch (phase) {
    case 'PHOTO_OPEN':
      return { scale: 1, rotateX: 0, rotateY: 0, rotateZ: 0, opacity: 1 };
    case 'GRABBING_CLOSING':
      return { scale: 0.28, rotateX: tiltX, rotateY: tiltY, rotateZ: tiltZ, opacity: 0.95 };
    case 'HOLDING_IN_HAND':
      return { scale: 0.22, rotateX: tiltX, rotateY: tiltY, rotateZ: tiltZ, opacity: 0.96 };
    case 'DELIVERING':
      return { scale: 0.06, rotateX: 18, rotateY: 28, rotateZ: 12, opacity: 0 };
    case 'DELIVERED':
      return { scale: 0, rotateX: 0, rotateY: 0, rotateZ: 0, opacity: 0 };
  }
}
