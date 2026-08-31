/**
 * Coordinate systems used across Scan&Sign — read this before touching any zone code.
 *
 *  1. SCREEN / VIEWPORT  — pixels, origin TOP-LEFT, y grows downward.
 *     Produced by the admin template editor (PDF.js canvas) and by the mobile
 *     region picker (photo displayed in a <Image>). Device dependent. Never stored.
 *
 *  2. NORMALIZED         — 0..1 fractions of the page (or photo) box,
 *     origin TOP-LEFT, y grows downward. This is the ONLY form persisted in
 *     Postgres, which makes zones independent of screen size, zoom and DPI.
 *
 *  3. PDF POINTS         — 1/72 inch, origin BOTTOM-LEFT, y grows upward.
 *     What pdf-lib draws with. Computed on the fly at generation time.
 *
 * Conversions live in @scansign/pdf (`screenToNormalizedRect`,
 * `normalizedToPdfRect`) and are unit-tested there.
 */

/** Rectangle in normalized 0..1 space, origin top-left. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rectangle in raw pixels, origin top-left. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rectangle in PDF points, origin bottom-left — pdf-lib's drawImage space. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const isNormalizedRect = (r: NormalizedRect): boolean =>
  Number.isFinite(r.x) &&
  Number.isFinite(r.y) &&
  Number.isFinite(r.width) &&
  Number.isFinite(r.height) &&
  r.width > 0 &&
  r.height > 0 &&
  r.x >= 0 &&
  r.y >= 0 &&
  r.x + r.width <= 1 + 1e-6 &&
  r.y + r.height <= 1 + 1e-6;

export const clampNormalizedRect = (r: NormalizedRect): NormalizedRect => {
  const x = Math.min(Math.max(r.x, 0), 1);
  const y = Math.min(Math.max(r.y, 0), 1);
  return {
    x,
    y,
    width: Math.min(Math.max(r.width, 0), 1 - x),
    height: Math.min(Math.max(r.height, 0), 1 - y),
  };
};

/** Which corner of a selection rectangle is being dragged. */
export type RectCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Move a rectangle by a normalized delta, keeping it fully inside 0..1.
 * The size never changes: a box pushed against an edge stops rather than
 * shrinking, which is what a finger dragging it expects.
 */
export const moveNormalizedRect = (
  rect: NormalizedRect,
  dx: number,
  dy: number,
): NormalizedRect => ({
  x: Math.min(Math.max(rect.x + dx, 0), Math.max(1 - rect.width, 0)),
  y: Math.min(Math.max(rect.y + dy, 0), Math.max(1 - rect.height, 0)),
  width: rect.width,
  height: rect.height,
});

/**
 * Resize a rectangle by dragging one corner. The opposite corner stays pinned,
 * the result never leaves 0..1, and it never collapses below the given minimum
 * — dragging past the pin pushes the dragged edge back instead of inverting the
 * rectangle.
 */
export const resizeNormalizedRect = (
  rect: NormalizedRect,
  corner: RectCorner,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number,
): NormalizedRect => {
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';

  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  let left = west ? clamp(rect.x + dx) : rect.x;
  let top = north ? clamp(rect.y + dy) : rect.y;
  let newRight = west ? right : clamp(right + dx);
  let newBottom = north ? bottom : clamp(bottom + dy);

  if (newRight - left < minWidth) {
    if (west) left = Math.max(newRight - minWidth, 0);
    else newRight = Math.min(left + minWidth, 1);
  }
  if (newBottom - top < minHeight) {
    if (north) top = Math.max(newBottom - minHeight, 0);
    else newBottom = Math.min(top + minHeight, 1);
  }

  return {
    x: left,
    y: top,
    width: Math.max(newRight - left, 0),
    height: Math.max(newBottom - top, 0),
  };
};
