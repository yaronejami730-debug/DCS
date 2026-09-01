import type { NormalizedRect, PdfRect, PixelRect } from '@scansign/shared';

/**
 * Coordinate conversions between the three spaces described in
 * @scansign/shared/geometry.ts.
 *
 * The hard part is page rotation. A PDF page carries a /Rotate entry
 * (0 | 90 | 180 | 270) that viewers apply before showing it. PDF.js in the
 * admin editor draws the ROTATED page, so the normalized rect we persist is
 * expressed in *viewport* space. pdf-lib draws in *unrotated user space*.
 * Everything below maps between the two, and also works out how much to spin
 * the stamped image so it looks upright to a human reading the document.
 */

export type PageRotation = 0 | 90 | 180 | 270;

export const normalizeRotation = (deg: number): PageRotation => {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as PageRotation;
};

/** Size of the page as the viewer (and the template editor) sees it. */
export const viewportSize = (
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation,
): { width: number; height: number } =>
  rotation === 90 || rotation === 270
    ? { width: pageHeight, height: pageWidth }
    : { width: pageWidth, height: pageHeight };

/**
 * Screen pixels -> normalized 0..1. Both spaces have their origin top-left,
 * so this is a pure scale. `containerWidth/Height` is the on-screen size of
 * the rendered page (or photo), NOT the intrinsic size.
 */
export const screenToNormalizedRect = (
  rect: PixelRect,
  containerWidth: number,
  containerHeight: number,
): NormalizedRect => {
  if (containerWidth <= 0 || containerHeight <= 0) {
    throw new Error('screenToNormalizedRect: container must have a positive size');
  }
  return {
    x: rect.x / containerWidth,
    y: rect.y / containerHeight,
    width: rect.width / containerWidth,
    height: rect.height / containerHeight,
  };
};

/** Normalized 0..1 -> screen pixels. Inverse of screenToNormalizedRect. */
export const normalizedToScreenRect = (
  rect: NormalizedRect,
  containerWidth: number,
  containerHeight: number,
): PixelRect => ({
  x: rect.x * containerWidth,
  y: rect.y * containerHeight,
  width: rect.width * containerWidth,
  height: rect.height * containerHeight,
});

/** Normalized 0..1 -> pixels of a source image, rounded to whole pixels. */
export const normalizedToPixelRect = (
  rect: NormalizedRect,
  imageWidth: number,
  imageHeight: number,
): PixelRect => {
  const x = Math.round(rect.x * imageWidth);
  const y = Math.round(rect.y * imageHeight);
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(rect.width * imageWidth), imageWidth - x)),
    height: Math.max(1, Math.min(Math.round(rect.height * imageHeight), imageHeight - y)),
  };
};

/**
 * Normalized viewport rect -> axis-aligned rect in PDF user space
 * (points, origin BOTTOM-LEFT), accounting for page rotation.
 *
 * `pageWidth`/`pageHeight` are the UNROTATED mediabox dimensions, i.e. exactly
 * what `pdf-lib`'s `page.getSize()` returns.
 */
export const normalizedToPdfRect = (
  rect: NormalizedRect,
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation = 0,
): PdfRect => {
  const vp = viewportSize(pageWidth, pageHeight, rotation);
  const dx = rect.x * vp.width;
  const dy = rect.y * vp.height;
  const dw = rect.width * vp.width;
  const dh = rect.height * vp.height;

  switch (rotation) {
    case 0:
      return { x: dx, y: pageHeight - dy - dh, width: dw, height: dh };
    case 90:
      // viewport (dx, dy) maps to user (x = dy, y = dx)
      return { x: dy, y: dx, width: dh, height: dw };
    case 180:
      return { x: pageWidth - dx - dw, y: dy, width: dw, height: dh };
    case 270:
      // viewport (dx, dy) maps to user (x = W - dy, y = H - dx)
      return { x: pageWidth - dy - dh, y: pageHeight - dx - dw, width: dh, height: dw };
  }
};

/**
 * Shrink `source` to fit inside `box` without distortion, then centre it.
 * Both rects are in the same space. Used so a wide signature never gets
 * squashed into a square zone.
 */
export const containFit = (
  sourceWidth: number,
  sourceHeight: number,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } => {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('containFit: source must have a positive size');
  }
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
};

/**
 * How a mark is sized inside the zone drawn for it.
 *
 * `containFit` alone gets this wrong in practice, and the measurements say why.
 * Operators draw a wide, flat box along the signature line — measured on real
 * templates, zone aspect ratios of 2.5, 3.2 and 7.0 — while an ink cutout is
 * far less elongated: 1.6 for a signature over a stamp, 4.4 for a handwritten
 * "Lu et approuvé". Fitting the second inside the first is always limited by
 * HEIGHT, so the mark filled 100% of the zone's height and only 23-65% of its
 * width. The width the operator carefully drew was being ignored, and the mark
 * came out small — sized by the box's thickness rather than by its extent.
 *
 * So the width leads. The mark is scaled to fill the zone's width, and its
 * height follows from its own aspect ratio. Because that can make a squarish
 * mark taller than a flat box, the height is capped at `maxHeightOverflow`
 * times the zone height — beyond that the mark would start reaching into the
 * printed text above and below, which no amount of "correct scale" justifies.
 * Nothing is ever distorted: the aspect ratio is preserved throughout, and the
 * result is centred on the zone.
 */
export interface MarkFitOptions {
  /**
   * Fraction of the zone's width the mark should occupy. Slightly under 1 so a
   * mark does not touch the edges of the box it was given.
   */
  fill?: number;
  /**
   * How far the mark's height may exceed the zone's height. 1 reproduces the
   * old strict contain behaviour.
   */
  maxHeightOverflow?: number;
}

export const DEFAULT_MARK_FIT: Required<MarkFitOptions> = {
  /**
   * Fill the drawn width completely. Insetting it "so the mark does not touch
   * the edges" was tried and dropped: the box IS the operator's statement of
   * how much room the mark gets, and shrinking it by a few percent both fought
   * that intent and broke the property that a square mark in a square zone
   * lands exactly on the zone.
   */
  fill: 1,
  maxHeightOverflow: 1.5,
};

export const fitMarkInZone = (
  sourceWidth: number,
  sourceHeight: number,
  box: { x: number; y: number; width: number; height: number },
  options: MarkFitOptions = {},
): { x: number; y: number; width: number; height: number } => {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('fitMarkInZone: source must have a positive size');
  }

  const fill = options.fill ?? DEFAULT_MARK_FIT.fill;
  const maxHeightOverflow = options.maxHeightOverflow ?? DEFAULT_MARK_FIT.maxHeightOverflow;

  // Width leads: this is the dimension the operator drew deliberately.
  const byWidth = (box.width * fill) / sourceWidth;
  // …but never so tall that the mark climbs out of its line into the text.
  const byHeight = (box.height * maxHeightOverflow) / sourceHeight;
  const scale = Math.min(byWidth, byHeight);

  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
};

/**
 * How one signing differs from another, applied where it survives.
 *
 * The obvious place to vary a mark is the cutout, and it is the wrong one: the
 * cutout is trimmed to its ink and then fitted into its zone, and those two
 * steps normalise away precisely a translation and a scale. Measured, a model
 * that asked for a 6.6% displacement delivered 0.5% to the page — the visible
 * part had been divided out.
 *
 * Applied to the PLACEMENT instead, nothing normalises it afterwards. A mark
 * 6% smaller stays 6% smaller; one sitting 4% to the left stays there. Which is
 * what actually distinguishes two signings at a glance: a hand does not land in
 * the same spot, at the same size, at the same angle, twice.
 */
export interface MarkVariation {
  /**
   * Multipliers on the fitted size, separately per axis.
   *
   * Separate on purpose. A uniform scale makes the mark bigger or smaller; a
   * slightly different one per axis also changes the SHAPE of every stroke —
   * loops rounder or narrower, the slant of every upstroke shifted — which is
   * the "un peu déformée" that makes two signings read as two signings. It
   * cannot break anything the way a local warp can, because it is one affine
   * map over the whole mark.
   */
  scaleX: number;
  scaleY: number;
  /** Shift, as a fraction of the mark's own width and height. */
  offsetX: number;
  offsetY: number;
  /** Tilt in degrees, counter-clockwise, about the mark's centre. */
  tiltDegrees: number;
}

export const NO_VARIATION: MarkVariation = {
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
  tiltDegrees: 0,
};

/**
 * Apply a variation to a placement, rotating and scaling about the mark's own
 * centre so it stays where it was put rather than swinging off its corner.
 *
 * pdf-lib rotates a drawn image about its (x, y) anchor — the bottom-left — so
 * a tilt applied naively also translates the mark by an amount that grows with
 * its size. Recovering the centre first and re-deriving the anchor for the new
 * angle keeps the tilt a tilt.
 */
export const applyMarkVariation = (
  placement: ImagePlacement,
  variation: MarkVariation,
): ImagePlacement => {
  const { scaleX, scaleY, offsetX, offsetY, tiltDegrees } = variation;
  if (scaleX === 1 && scaleY === 1 && offsetX === 0 && offsetY === 0 && tiltDegrees === 0) {
    return placement;
  }

  const angle = (placement.rotateDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Where the mark's centre currently is, in PDF user space.
  const cx = placement.x + (placement.width / 2) * cos - (placement.height / 2) * sin;
  const cy = placement.y + (placement.width / 2) * sin + (placement.height / 2) * cos;

  const width = placement.width * scaleX;
  const height = placement.height * scaleY;

  // Offsets are along the mark's own axes, so a mark on a rotated page moves
  // the way it looks like it should rather than along the paper's edges.
  const shiftX = offsetX * width;
  const shiftY = offsetY * height;
  const movedX = cx + shiftX * cos - shiftY * sin;
  const movedY = cy + shiftX * sin + shiftY * cos;

  const tilted = placement.rotateDegrees + tiltDegrees;
  const ta = (tilted * Math.PI) / 180;
  const tcos = Math.cos(ta);
  const tsin = Math.sin(ta);

  return {
    x: movedX - (width / 2) * tcos + (height / 2) * tsin,
    y: movedY - (width / 2) * tsin - (height / 2) * tcos,
    width,
    height,
    rotateDegrees: tilted,
  };
};

/**
 * Map a single point from viewport space (origin top-left, page rotation
 * applied — what the operator sees) to PDF user space (origin bottom-left).
 *
 * `normalizedToPdfRect` handles boxes; this handles the anchors that boxes
 * cannot express, such as where a text label should start.
 */
export const viewportPointToPdfPoint = (
  x: number,
  y: number,
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation = 0,
): { x: number; y: number } => {
  switch (rotation) {
    case 0:
      return { x, y: pageHeight - y };
    case 90:
      return { x: y, y: x };
    case 180:
      return { x: pageWidth - x, y };
    case 270:
      return { x: pageWidth - y, y: pageHeight - x };
  }
};

/** What pdf-lib needs to stamp an image: a box plus a counter-clockwise angle. */
export interface ImagePlacement extends PdfRect {
  /**
   * Counter-clockwise degrees, as expected by pdf-lib's `degrees()`.
   *
   * A page's own rotation is always one of the four right angles; a per-signing
   * tilt lands it anywhere, so this is a plain number rather than that union.
   */
  rotateDegrees: number;
}

/**
 * Full placement pipeline for one stamped image.
 *
 * normalized viewport rect + page rotation + image aspect ratio
 *   -> pdf-lib draw parameters that render the image upright, centred in the
 *      zone the operator drew, with its aspect ratio preserved.
 *
 * The returned `x`/`y` is the anchor pdf-lib rotates around (its draw origin),
 * NOT the bottom-left of the visible box, because pdf-lib rotates about the
 * draw origin. For rotation 0 the two coincide.
 */
export const computeImagePlacement = (params: {
  rect: NormalizedRect;
  pageWidth: number;
  pageHeight: number;
  rotation?: PageRotation;
  imageWidth: number;
  imageHeight: number;
  /** Overrides how the mark is scaled into the zone. See DEFAULT_MARK_FIT. */
  fit?: MarkFitOptions;
}): ImagePlacement => {
  const { rect, pageWidth, pageHeight, imageWidth, imageHeight } = params;
  const rotation = params.rotation ?? 0;
  const vp = viewportSize(pageWidth, pageHeight, rotation);

  // 1. zone in viewport points
  const zone = {
    x: rect.x * vp.width,
    y: rect.y * vp.height,
    width: rect.width * vp.width,
    height: rect.height * vp.height,
  };

  // 2. size the image inside the zone, in viewport space, where "width" and
  //    "height" mean what the reader sees. Width-led — see fitMarkInZone for
  //    why strict contain made every mark come out too small.
  const fitted = fitMarkInZone(imageWidth, imageHeight, zone, params.fit);

  // 3. map the fitted viewport box to pdf-lib draw parameters.
  const dx = fitted.x;
  const dy = fitted.y;
  const dw = fitted.width;
  const dh = fitted.height;

  switch (rotation) {
    case 0:
      return {
        x: dx,
        y: pageHeight - dy - dh,
        width: dw,
        height: dh,
        rotateDegrees: 0,
      };
    case 90:
      // local +y must point along user -x, so spin 90deg CCW and anchor right.
      return { x: dy + dh, y: dx, width: dw, height: dh, rotateDegrees: 90 };
    case 180:
      return {
        x: pageWidth - dx,
        y: dy + dh,
        width: dw,
        height: dh,
        rotateDegrees: 180,
      };
    case 270:
      return {
        x: pageWidth - dy - dh,
        y: pageHeight - dx,
        width: dw,
        height: dh,
        rotateDegrees: 270,
      };
  }
};
