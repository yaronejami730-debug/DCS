/**
 * Types of the live document scanner.
 *
 * Coordinates: every corner the scanner exposes to the UI is NORMALIZED to the
 * camera frame (0..1, origin top-left), like every other rectangle in this code
 * base. The overlay maps them to the screen through an SVG viewBox that mirrors
 * the video's `object-fit: cover`, so the contour lands on the paper whatever
 * the phone's aspect ratio. Pixel coordinates exist only inside the hook, at
 * detection and at capture.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Corners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export const CORNER_KEYS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;
export type CornerKey = (typeof CORNER_KEYS)[number];

/** Why the frame is, or is not, ready to capture. */
export type ScannerStatus =
  | 'searching'
  | 'partial'
  | 'too_small'
  | 'too_close'
  | 'tilted'
  | 'unstable'
  | 'blurry'
  | 'dark'
  | 'ready'
  | 'capturing';

export type ScannerTone = 'red' | 'orange' | 'green';

export interface ScannerVerdict {
  status: ScannerStatus;
  /** True only when every check passed AND the stability window elapsed. */
  ready: boolean;
  /** The document as last seen, when four corners were found; null otherwise. */
  corners: Corners | null;
}

export type CameraPermission = 'checking' | 'granted' | 'prompt' | 'denied' | 'unsupported';

/** What the scanner hands back: the straightened page, and the shot it came from. */
export interface ScannedDocument {
  /** Object URL of the straightened, perspective-corrected JPEG. */
  uri: string;
  blob: Blob;
  width: number;
  height: number;
  /** Where the page was in the original frame, normalized 0..1. */
  corners?: Corners;
  /** The untouched full-resolution frame, for whoever wants to re-crop. */
  original: { uri: string; blob: Blob; width: number; height: number };
}

/** Tunables of the framing validation, all in normalized frame units. */
export interface ValidationOptions {
  /** A corner closer than this to a frame edge counts as cut off. */
  edgeMargin: number;
  /** The quad must cover at least this share of the frame. */
  minCoverage: number;
  /** …and at most this share (too close: edges likely outside the sensor). */
  maxCoverage: number;
  /** Corner angles accepted, in degrees, around 90. */
  minCornerAngle: number;
  maxCornerAngle: number;
  /** Opposite sides may differ by at most this ratio of the longer one. */
  maxOppositeSideDifference: number;
  /** Width/height (or the inverse) of the quad's bounding box. */
  maxAspectRatio: number;
}

export const DEFAULT_VALIDATION: ValidationOptions = {
  edgeMargin: 0.012,
  minCoverage: 0.2,
  maxCoverage: 0.93,
  minCornerAngle: 62,
  maxCornerAngle: 118,
  maxOppositeSideDifference: 0.32,
  maxAspectRatio: 2.6,
};

export interface StabilityOptions {
  /** How long the frame must stay valid before capture is allowed. */
  holdMs: number;
  /** Max corner displacement between two frames, as a share of the frame diagonal. */
  maxJitter: number;
}

export const DEFAULT_STABILITY: StabilityOptions = {
  holdMs: 600,
  // Measured on a hand-held phone: tremor alone moves smoothed corners by
  // 1–2 % of the diagonal between frames. 2 % restarted the clock constantly.
  maxJitter: 0.035,
};
