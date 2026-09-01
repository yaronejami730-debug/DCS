/**
 * SynSig2Vec-style signature synthesis: one photographed signature in, a family
 * of kinematically distinct signings out.
 *
 *   photo of ink
 *     -> skeleton -> pen-plausible stroke order -> timing from the 2/3 power law
 *     -> Sigma-Lognormal decomposition (D, t0, μ, σ, θs, θe per movement)
 *     -> perturb the motor parameters
 *     -> re-integrate -> displacement of the real ink
 *
 * What separates this from a filter is where the variation is injected. A warp
 * moves pixels; this moves the *commands* that produced them, and lets the
 * consequences fall out of the model — a stroke that fires a little earlier
 * overlaps its neighbour differently, so the join between two letters changes
 * shape rather than merely sliding.
 *
 * It is still cosmetic, and still deterministic: variant `n` of a given cutout
 * is always the same image, because every parameter comes from a hash of `n`.
 * The document remains an electronically assembled PDF.
 */

import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { traceSignature, type Trajectory } from './trajectory.js';
import {
  DEFAULT_RANGE,
  fitSignature,
  perturb,
  reconstructRun,
  reconstructionError,
  type PerturbationRange,
  type SignatureModel,
} from './sigma-lognormal.js';
import { applyInkWeight, warpByCorrespondence, type Correspondence } from './render.js';

export { traceSignature, thin, resampleUniform, timePath } from './trajectory.js';
export type { Point, TimedPoint, Trajectory } from './trajectory.js';
export {
  fitSignature,
  fitRun,
  lognormal,
  perturb,
  reconstructRun,
  reconstructionError,
  DEFAULT_RANGE,
} from './sigma-lognormal.js';
export type { LognormalStroke, SignatureModel, RunModel } from './sigma-lognormal.js';

export interface ModelledSignature {
  trajectory: Trajectory;
  model: SignatureModel;
  /** Mean reconstruction error, as a fraction of the mark's height. */
  error: number;
}

/**
 * Worst reconstruction error we will still build a variant from.
 *
 * Above this the decomposition has not understood the mark — a mask that
 * skeletonised into confetti, a stamp mistaken for handwriting — and its
 * "variants" would be deformations of something the model got wrong. Better to
 * fall back to the plain filter, which cannot be that wrong because it cannot
 * be that clever.
 */
const MAX_ERROR = 0.09;

/**
 * Modelling is the expensive half — thinning and graph traversal over every ink
 * pixel — and every variant of one cutout re-uses the identical model. A tiny
 * cache keyed by the image bytes turns a preview of eight variants into one
 * trace instead of eight.
 */
const cache = new Map<string, ModelledSignature | null>();
const CACHE_LIMIT = 8;

const remember = (key: string, value: ModelledSignature | null): ModelledSignature | null => {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
};

/** Trace and decompose a cutout. Null when it cannot be modelled. */
export const modelSignature = async (png: Uint8Array): Promise<ModelledSignature | null> => {
  const key = createHash('sha256').update(png).digest('hex');
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const { data, info } = await sharp(Buffer.from(png))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return remember(key, null);

    const trajectory = traceSignature(data, info.width, info.height);
    if (!trajectory) return remember(key, null);

    const model = fitSignature(trajectory);
    if (!model) return remember(key, null);

    const error = reconstructionError(model);
    if (!Number.isFinite(error) || error > MAX_ERROR) return remember(key, null);

    return remember(key, { trajectory, model, error });
  } catch {
    return remember(key, null);
  }
};

/**
 * The shape change that survives everything downstream.
 *
 * Trimming the cutout to its ink removes a translation; fitting it into its
 * zone removes a scale. Those two steps are why varying position and size on
 * the image achieved nothing — but they remove ONLY those. A shear survives. A
 * change of aspect ratio survives. A rotation survives. And all three change
 * the shape of every stroke: the slant of the upstrokes, how round or how
 * narrow the loops come out, which way the whole hand leans.
 *
 * That is what makes two signings look like two signings at a glance, and it is
 * something the local warp cannot deliver: warping photographed ink cannot move
 * two strokes in different directions where they cross, and a looping signature
 * is mostly crossings — 6.6% of requested displacement arrived as 0.5%. An
 * affine map has no such limit because it moves the whole plane at once.
 *
 * Nothing here can break a letterform. A shear does not fragment a stroke; it
 * leans it.
 */
const shapeFor = (
  seed: string,
  strength: number,
): { shear: number; aspect: number; rotate: number } => {
  const digest = createHash('sha256').update(`${seed}:shape`).digest();
  const unit = (i: number) => (digest[i % digest.length]! / 255) * 2 - 1;
  // Bounded so the mark still reads as one person's hand. Past roughly twice
  // this, the slant alone starts to look like a different signatory.
  const k = Math.min(2.5, Math.max(0, strength));
  return {
    shear: unit(0) * 0.085 * k,
    aspect: unit(1) * 0.055 * k,
    rotate: unit(2) * 2.6 * k,
  };
};

/**
 * Lean, stretch and turn the mark by that much, preserving transparency.
 *
 * Applied after the warp so the kinematic deformation is carried along by it
 * rather than fighting it.
 */
const applyShape = async (
  png: Uint8Array,
  shape: { shear: number; aspect: number; rotate: number },
): Promise<Uint8Array> => {
  const radians = (shape.rotate * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = 1 + shape.aspect;
  const sy = 1 - shape.aspect;

  // Rotation composed with a horizontal shear and a per-axis scale.
  const matrix: [number, number, number, number] = [
    cos * sx + shape.shear * sin * sy,
    -sin * sx + shape.shear * cos * sy,
    sin * sy,
    cos * sy,
  ];

  const out = await sharp(Buffer.from(png))
    .ensureAlpha()
    .affine(matrix, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      interpolator: sharp.interpolators.bilinear,
    })
    .png()
    .toBuffer();
  return new Uint8Array(out);
};

/**
 * How the pen itself differs between two signings, on top of the movement.
 *
 * Derived from the same seed so it stays deterministic, and kept to the range a
 * real pen covers: a little fuller and darker, or thinner and drier.
 */
const penFor = (seed: string, strength: number): { gamma: number; density: number } => {
  const digest = createHash('sha256').update(`${seed}:pen`).digest();
  const unit = (i: number) => (digest[i % digest.length]! / 255) * 2 - 1;
  /**
   * The pen carries most of the visible difference, and it is the only part
   * that survives intact.
   *
   * Geometry has a ceiling here that no amount of tuning removes: the mark is
   * varied by warping the photographed ink, and a warp cannot move two strokes
   * in different directions where they cross — at the crossing there is one
   * pixel. A looping signature is mostly crossings, so the differential motion
   * the model computes largely cancels itself. Measured, 6.6% of requested
   * displacement arrived as 0.5%.
   *
   * Stroke weight has no such limit. It is also what actually distinguishes two
   * signings to the eye: one comes out fuller and darker, the next thinner and
   * drier, because the pen was loaded differently and pressed harder. That is
   * "la même signature, un peu moins bien faite" far more than a millimetre of
   * displacement is.
   */
  // Bounded hard: past this the gamma thins strokes until they break, and a
  // broken signature is worse than an identical one.
  const scale = Math.min(1.3, Math.max(0.5, strength));
  return {
    gamma: 1 - unit(0) * 0.26 * scale,
    density: 1 + unit(1) * 0.12 * scale,
  };
};

export interface SynthesisOptions {
  /** Override how far the motor parameters may move. */
  range?: PerturbationRange;
  /** Skip the pen weight/density variation and change only the movement. */
  motionOnly?: boolean;
  /** Multiplies the pen's variation. 1 is one hand signing twice in a row. */
  penStrength?: number;
}

/**
 * Build variant `index` of a signature cutout.
 *
 * Returns null when the mark could not be modelled, which is the caller's cue
 * to fall back. Never throws: a variant is a nicety, and a signature that
 * cannot be varied still signs the document correctly.
 */
export const synthesizeVariant = async (
  png: Uint8Array,
  index: number,
  options: SynthesisOptions = {},
): Promise<Uint8Array | null> => {
  try {
    const modelled = await modelSignature(png);
    if (!modelled) return null;

    const seed = `synsig:${index}`;
    const varied = perturb(modelled.model, seed, options.range ?? DEFAULT_RANGE);

    // The displacement is the difference between the two *models*, so whatever
    // the fit got wrong appears in both and cancels.
    const correspondences: Correspondence[] = [];
    const strengthForRuns = options.penStrength ?? 1;

    for (let r = 0; r < modelled.model.runs.length; r++) {
      const base = modelled.model.runs[r]!;
      const other = varied.runs[r]!;
      const from = reconstructRun(base);
      const to = reconstructRun(other);

      /**
       * A small affine of its own for each pen-down run.
       *
       * This is what makes two signings look like two signings, and neither the
       * kinematic warp nor a global transform delivers it. The warp cannot move
       * two strokes apart where they cross, and a looping signature is mostly
       * crossings. A global shear or tilt does move everything, but the eye
       * reads that as one signature leaning, not as a different signing.
       *
       * What the eye actually reads is the proportion between the PARTS: a loop
       * a little larger relative to the flourish beneath it, an underline that
       * reaches a little further, one element sitting slightly differently
       * against another. Varying each run about its own centroid produces
       * exactly that, and a hand does the same thing — it never places two
       * strokes in identical relation twice.
       *
       * Kept small per run. The parts must move relative to one another without
       * any of them coming loose from the signature.
       */
      const digest = createHash('sha256').update(`${seed}:run:${r}`).digest();
      const unit = (i: number) => (digest[i % digest.length]! / 255) * 2 - 1;
      const k = Math.min(2.5, Math.max(0, strengthForRuns));
      const runScale = 1 + unit(0) * 0.05 * k;
      const runAngle = unit(1) * 0.035 * k;
      const runShiftX = unit(2) * 0.03 * k;
      const runShiftY = unit(3) * 0.03 * k;

      let cx = 0;
      let cy = 0;
      for (const point of base.traced) {
        cx += point.x;
        cy += point.y;
      }
      cx /= Math.max(1, base.traced.length);
      cy /= Math.max(1, base.traced.length);

      const cos = Math.cos(runAngle);
      const sin = Math.sin(runAngle);
      const span = modelled.model.height;

      for (let i = 0; i < base.traced.length; i++) {
        const a = from[i];
        const b = to[i];
        if (!a || !b) continue;
        const anchor = base.traced[i]!;

        // The kinematic displacement…
        const kx = anchor.x + (b.x - a.x);
        const ky = anchor.y + (b.y - a.y);

        // …then this run's own placement, about its centroid.
        const rx = kx - cx;
        const ry = ky - cy;
        correspondences.push({
          from: anchor,
          to: {
            x: cx + (rx * cos - ry * sin) * runScale + runShiftX * span,
            y: cy + (rx * sin + ry * cos) * runScale + runShiftY * span,
          },
        });
      }
    }

    if (correspondences.length < 3) return null;

    const warped = await warpByCorrespondence(png, correspondences, {
      penRadius: modelled.trajectory.penRadius,
    });

    const strength = options.penStrength ?? 1;
    const shaped = await applyShape(warped, shapeFor(seed, strength));
    const inked = options.motionOnly ? shaped : await applyInkWeight(shaped, penFor(seed, strength));

    const trimmed = await sharp(Buffer.from(inked)).trim({ threshold: 1 }).png().toBuffer();
    return new Uint8Array(trimmed);
  } catch {
    return null;
  }
};

/** Test and tooling helper: forget everything modelled so far. */
export const clearModelCache = (): void => cache.clear();
