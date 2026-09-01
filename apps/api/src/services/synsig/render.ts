/**
 * Put the signer's real ink onto the synthesised trajectory.
 *
 * There are two ways to turn a Sigma-Lognormal model back into an image. The
 * obvious one is to redraw it — sweep a nib along the integrated path. It is
 * also the wrong one here: the result is a clean synthetic curve that has lost
 * the ballpoint skips, the pressure blooms and the paper texture that make the
 * cutout look like ink rather than a font. On a contract that difference is
 * immediately visible.
 *
 * So instead the model supplies only the *deformation*. We integrate the fitted
 * model and the perturbed model on the same time grid, and the difference
 * between them, sample by sample, is how far the pen would have been at that
 * instant had the movement gone the other way. Anchoring that displacement on
 * the traced points and interpolating it across the plane gives a warp field
 * that moves the original photographed ink along a kinematically synthesised
 * path. Reconstruction error cancels — it appears in both models and subtracts
 * out — so an imperfect fit degrades into a gentler variant, never a wrong one.
 */

import sharp from 'sharp';
import type { Point } from './trajectory.js';

export interface Correspondence {
  /** Where the ink is now — a point on the traced trajectory. */
  from: Point;
  /** Where this movement would have put it in the variant. */
  to: Point;
}

export interface WarpOptions {
  /** Half the pen width; sets how tightly the field hugs the strokes. */
  penRadius: number;
  /** Resolution of the displacement grid, in pixels. */
  cellSize?: number;
  /** Cap on anchors used, for cost. Anchors are dense along every stroke. */
  maxAnchors?: number;
  /** Reach of the field, in pen radii. See the note where it is used. */
  sigmaRadii?: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Warp a transparent PNG so that each anchor's ink lands on its target.
 *
 * The field is built as an *inverse* map — for an output pixel, where in the
 * source did it come from — with the anchors placed at their targets. That
 * makes it exact at every anchor by construction, rather than approximately
 * invertible, which matters because the strokes are exactly where the anchors
 * are.
 *
 * Weights are Gaussian in distance and normalised, so far from any ink the
 * field decays to identity and the background never smears.
 */
export const warpByCorrespondence = async (
  png: Uint8Array,
  correspondences: Correspondence[],
  options: WarpOptions,
): Promise<Uint8Array> => {
  if (correspondences.length < 3) return png;

  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels !== 4 || width < 8 || height < 8) return png;

  // Thin the anchors: a stroke resampled every 1.5px gives far more than the
  // field can resolve, and cost is anchors x grid cells.
  const maxAnchors = options.maxAnchors ?? 420;
  const stride = Math.max(1, Math.ceil(correspondences.length / maxAnchors));
  const anchors = correspondences.filter((_, i) => i % stride === 0);

  let maxShift = 0;
  for (const a of anchors) {
    maxShift = Math.max(maxShift, Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y));
  }

  const pad = Math.ceil(maxShift + options.penRadius + 2);
  const outWidth = width + pad * 2;
  const outHeight = height + pad * 2;

  /**
   * How far a stroke's influence reaches.
   *
   * This is the number that decides whether any of the model's work survives.
   * It used to include a `height * 0.1` term, which on a real mark meant 87px —
   * far wider than the gaps between strokes. A field that smooth cannot express
   * differential motion: it averages the per-stroke displacements into what is
   * essentially one translation plus one scale, and the trim afterwards removes
   * the translation while fitting the mark into its zone removes the scale. So
   * the model computed a 3.15% displacement and 0.49% reached the page.
   *
   * Tying the reach to the pen instead keeps the field local enough to move one
   * stroke without dragging its neighbour along.
   */
  const sigma = Math.max(6, options.penRadius * 5, height * 0.1);
  const twoSigmaSq = 2 * sigma * sigma;
  const reach = sigma * 3;
  const reachSq = reach * reach;

  /**
   * The grid must resolve the field, not average it away.
   *
   * This was a fixed fraction of the image — 31px on a real mark — while the
   * field's reach was about the same. Grid nodes then landed outside every
   * anchor's influence, their displacement stayed zero, and the interpolation
   * between them smeared what little was left: the model asked for a 6.6%
   * displacement between two variants and 0.4% reached the image. Sampling at
   * half sigma keeps the grid fine enough to carry the field it is sampling.
   */
  const cell = Math.max(2, options.cellSize ?? Math.round(Math.min(width, height) / 28));
  const gridW = Math.ceil(outWidth / cell) + 1;
  const gridH = Math.ceil(outHeight / cell) + 1;
  const fieldX = new Float32Array(gridW * gridH);
  const fieldY = new Float32Array(gridW * gridH);

  for (let gy = 0; gy < gridH; gy++) {
    // Grid nodes live in source coordinates, hence the pad offset.
    const py = gy * cell - pad;
    for (let gx = 0; gx < gridW; gx++) {
      const px = gx * cell - pad;

      let weightSum = 0;
      let dx = 0;
      let dy = 0;
      for (const anchor of anchors) {
        const ax = px - anchor.to.x;
        const ay = py - anchor.to.y;
        const distSq = ax * ax + ay * ay;
        if (distSq > reachSq) continue;
        const w = Math.exp(-distSq / twoSigmaSq);
        weightSum += w;
        dx += w * (anchor.from.x - anchor.to.x);
        dy += w * (anchor.from.y - anchor.to.y);
      }

      const g = gy * gridW + gx;
      if (weightSum > 1e-6) {
        fieldX[g] = dx / weightSum;
        fieldY[g] = dy / weightSum;
      }
    }
  }

  const out = Buffer.alloc(outWidth * outHeight * 4, 0);

  for (let y = 0; y < outHeight; y++) {
    const sy = y - pad;
    const gy = y / cell;
    const gy0 = Math.min(gridH - 2, Math.floor(gy));
    const fy = gy - gy0;

    for (let x = 0; x < outWidth; x++) {
      const sx = x - pad;
      const gx = x / cell;
      const gx0 = Math.min(gridW - 2, Math.floor(gx));
      const fx = gx - gx0;

      // Bilinear read of the coarse displacement field.
      const i00 = gy0 * gridW + gx0;
      const i10 = i00 + 1;
      const i01 = i00 + gridW;
      const i11 = i01 + 1;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const shiftX =
        fieldX[i00]! * w00 + fieldX[i10]! * w10 + fieldX[i01]! * w01 + fieldX[i11]! * w11;
      const shiftY =
        fieldY[i00]! * w00 + fieldY[i10]! * w10 + fieldY[i01]! * w01 + fieldY[i11]! * w11;

      const srcX = sx + shiftX;
      const srcY = sy + shiftY;
      if (srcX < 0 || srcY < 0 || srcX >= width - 1 || srcY >= height - 1) continue;

      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const rx = srcX - x0;
      const ry = srcY - y0;

      const p00 = (y0 * width + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + width * 4;
      const p11 = p01 + 4;

      const c00 = (1 - rx) * (1 - ry);
      const c10 = rx * (1 - ry);
      const c01 = (1 - rx) * ry;
      const c11 = rx * ry;

      const o = (y * outWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = Math.round(
          data[p00 + c]! * c00 + data[p10 + c]! * c10 + data[p01 + c]! * c01 + data[p11 + c]! * c11,
        );
      }
    }
  }

  const encoded = await sharp(out, {
    raw: { width: outWidth, height: outHeight, channels: 4 },
  })
    .png()
    .toBuffer();
  return new Uint8Array(encoded);
};

export interface InkWeight {
  /** Gamma on coverage: below 1 fattens the stroke, above 1 slims it. */
  gamma: number;
  /** Multiplies final opacity — the same pen pressed harder or lighter. */
  density: number;
}

/**
 * Vary the pen rather than the letterforms.
 *
 * Applied to the alpha channel only, so shapes never move: the difference reads
 * as another moment of writing — a fuller nib, a lighter hand — on top of
 * whatever the trajectory did.
 */
export const applyInkWeight = async (png: Uint8Array, weight: InkWeight): Promise<Uint8Array> => {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) return png;

  const out = Buffer.from(data);
  for (let i = 3; i < out.length; i += 4) {
    const alpha = out[i]!;
    if (alpha === 0) continue;
    const shaped = Math.pow(alpha / 255, weight.gamma) * weight.density;
    out[i] = clamp(Math.round(shaped * 255), 0, 255);
  }

  const encoded = await sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return new Uint8Array(encoded);
};
