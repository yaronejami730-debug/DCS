import {
  DEFAULT_VALIDATION,
  type Corners,
  type ScannerStatus,
  type ScannerTone,
  type ValidationOptions,
} from '../types/scanner';
import {
  boundingBox,
  cornerAngles,
  cornerList,
  cornersAreFinite,
  isConvex,
  quadArea,
  sideLengths,
} from './perspective';

/**
 * Is this detection a page we would want to capture?
 *
 * One pure function, one verdict, in a fixed order of severity: the first
 * failing check names the status, so the message the signer reads is the one
 * thing they can fix right now. Stability and image quality are judged
 * elsewhere (they need time and pixels); this is geometry only.
 *
 * Corners are normalized to the frame (0..1). Nothing here touches the DOM.
 */
export type FramingStatus = Exclude<ScannerStatus, 'unstable' | 'blurry' | 'dark' | 'ready' | 'capturing'>;

export interface FramingResult {
  /** 'framed' when every geometric check passed. */
  status: FramingStatus | 'framed';
  /** Share of the frame the quad covers, for the UI's "closer / farther" hints. */
  coverage: number;
}

export const validateDocumentDetection = (
  corners: Corners | null,
  options: ValidationOptions = DEFAULT_VALIDATION,
): FramingResult => {
  if (!corners || !cornersAreFinite(corners)) return { status: 'searching', coverage: 0 };

  // 1. Entirely in frame: a corner on the edge is a corner we did not really see.
  const m = options.edgeMargin;
  const cutOff = cornerList(corners).some(
    (p) => p.x < m || p.y < m || p.x > 1 - m || p.y > 1 - m,
  );
  const coverage = quadArea(corners);
  if (cutOff) return { status: 'partial', coverage };

  // 2. Not a sliver, not a degenerate or bow-tie quad.
  if (!isConvex(corners)) return { status: 'searching', coverage };

  // 3. Size: enough pixels to be worth the extraction, not so many that the
  //    sensor is probably missing the edges.
  if (coverage < options.minCoverage) return { status: 'too_small', coverage };
  if (coverage > options.maxCoverage) return { status: 'too_close', coverage };

  // 4. Perspective: near-right angles, opposite sides of similar length, and a
  //    plausible page aspect. A page seen from a steep angle fails here.
  const angles = cornerAngles(corners);
  if (angles.some((a) => a < options.minCornerAngle || a > options.maxCornerAngle)) {
    return { status: 'tilted', coverage };
  }
  const [top, right, bottom, left] = sideLengths(corners);
  const differ = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b, 1e-9);
  if (
    differ(top, bottom) > options.maxOppositeSideDifference ||
    differ(left, right) > options.maxOppositeSideDifference
  ) {
    return { status: 'tilted', coverage };
  }
  const box = boundingBox(corners);
  const aspect = box.width / Math.max(box.height, 1e-9);
  if (aspect > options.maxAspectRatio || aspect < 1 / options.maxAspectRatio) {
    return { status: 'tilted', coverage };
  }

  return { status: 'framed', coverage };
};

/** What the signer reads, per status. Short, actionable, no jargon. */
export const STATUS_MESSAGE: Record<ScannerStatus, string> = {
  searching: 'Placez le document dans le cadre',
  partial: 'Document partiellement hors du cadre',
  too_small: 'Rapprochez légèrement le téléphone',
  too_close: 'Éloignez légèrement le téléphone',
  tilted: 'Document trop incliné',
  unstable: 'Maintenez le téléphone immobile',
  blurry: 'Image floue : tenez le téléphone stable',
  dark: 'Manque de lumière',
  ready: 'Document détecté',
  capturing: 'Capture…',
};

/** Red: nothing usable. Orange: a page, not yet right. Green: go. */
export const STATUS_TONE: Record<ScannerStatus, ScannerTone> = {
  searching: 'red',
  partial: 'red',
  too_small: 'orange',
  too_close: 'orange',
  tilted: 'orange',
  unstable: 'orange',
  blurry: 'orange',
  dark: 'orange',
  ready: 'green',
  capturing: 'green',
};
