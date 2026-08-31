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
