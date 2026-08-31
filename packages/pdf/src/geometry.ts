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
  /** Counter-clockwise degrees, as expected by pdf-lib's `degrees()`. */
  rotateDegrees: 0 | 90 | 180 | 270;
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

  // 2. fit the image inside the zone, in viewport space, where "width" and
  //    "height" mean what the reader sees.
  const fitted = containFit(imageWidth, imageHeight, zone);

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
