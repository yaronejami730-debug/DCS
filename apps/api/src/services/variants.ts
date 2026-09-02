import { HANDWRITTEN_MARKS, type ZoneType } from '@scansign/shared';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { applyInkWeight } from './synsig/render.js';
import type { MarkVariation } from '@scansign/pdf';
import { DEFAULT_RANGE, synthesizeVariant } from './synsig/index.js';

/**
 * Natural variation between repeated placements of the same handwritten mark.
 *
 * Someone signing five documents by hand produces five slightly different
 * signatures. Stamping one identical bitmap five times reads as mechanical,
 * which is the complaint this addresses: the marks should look like the same
 * hand signing repeatedly, not like a copy-paste.
 *
 * Two properties matter for this to be trustworthy:
 *
 *  1. **Deterministic.** The variation is derived from a seed (session,
 *     document, zone), so regenerating a document produces byte-identical
 *     output. A signature that changed every time you re-ran the pipeline
 *     would make the archive impossible to reason about.
 *  2. **Subtle.** The transforms stay inside the range a steady hand actually
 *     varies by — a degree or so of rotation, a few percent of scale, a
 *     hair of stroke weight. Anything stronger stops looking like the same
 *     signature, which defeats the purpose.
 *
 * Only handwritten marks are varied. A stamp is a physical die: it reproduces
 * identically by design, and varying it would look wrong rather than natural.
 *
 * This is cosmetic. It changes how the marks sit on the page, not what the
 * document is: the output remains an electronically assembled PDF, exactly as
 * it was before.
 */

export interface VariantParams {
  /** Degrees, counter-clockwise. */
  rotate: number;
  /** Multiplier around 1. */
  scale: number;
  /** Horizontal shear, as a fraction. */
  shear: number;
  /** Stroke weight nudge: negative thins, positive thickens. */
  weight: number;
  /** Ink density nudge: the same pen pressed a little harder or lighter. */
  density: number;
  /** Low-frequency wobble applied across the mark. See `elasticWarp`. */
  waves: Array<{ ampX: number; ampY: number; freqX: number; freqY: number; phase: number }>;
}

/**
 * Derive stable pseudo-random parameters from a seed.
 *
 * A hash rather than Math.random precisely so the same inputs always give the
 * same signature placement.
 */
export const variantParamsFor = (seed: string): VariantParams => {
  const digest = createHash('sha256').update(seed).digest();
  // Map bytes to [-1, 1].
  const unit = (index: number) => (digest[index % digest.length]! / 255) * 2 - 1;
  const positive = (index: number) => digest[index % digest.length]! / 255;

  return {
    rotate: unit(0) * 1.5,
    scale: 1 + unit(1) * 0.035,
    shear: unit(2) * 0.022,
    weight: unit(3),
    // Ink density: the same pen pressed a little harder or lighter.
    density: unit(19),
    /**
     * A single slow sweep, and a very small one.
     *
     * An earlier version stacked three waves at up to four cycles across the
     * mark with a 5.5% amplitude. That does make variants differ, but it
     * differs in the wrong way: the signature visibly ripples, which no hand
     * does. What separates two real signings is mostly weight, slant and a
     * gentle drift of the baseline — so the wobble is now slow and shallow
     * enough to read as drift, and the visible difference comes from the pen
     * instead.
     */
    waves: [
      {
        ampX: unit(4) * 0.5,
        ampY: unit(5) * 1,
        freqX: 0.35 + positive(6) * 0.3,
        freqY: 0.3 + positive(7) * 0.35,
        phase: positive(8) * Math.PI * 2,
      },
      {
        ampX: unit(9) * 0.25,
        ampY: unit(10) * 0.4,
        freqX: 0.9 + positive(11) * 0.5,
        freqY: 0.8 + positive(12) * 0.5,
        phase: positive(13) * Math.PI * 2,
      },
    ],
  };
};

/**
 * Bend the mark with a smooth, low-frequency displacement field.
 *
 * Rotation and scale alone were not enough, and the measurement said so: four
 * variants at ±1.4° and ±3% differed in bytes but were indistinguishable side
 * by side. The reason is that an affine transform moves every point of the mark
 * in lockstep, so the result is the same signature in a slightly different pose
 * — not the same hand signing again.
 *
 * A displacement field moves each part of the mark by a slightly different
 * amount, which is what a hand actually does: the loops drift, the baseline
 * wanders, the spacing between letters opens and closes. Summed sine waves at
 * one to four cycles across the mark give exactly that character, while staying
 * far too slow to distort the letterforms themselves.
 *
 * Amplitudes are in percent of the mark's height, so a small cutout and a large
 * one bend by the same visible amount.
 */
export const elasticWarp = async (
  png: Uint8Array,
  params: VariantParams,
): Promise<Uint8Array> => {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels !== 4 || width < 8 || height < 8) return png;

  // Pad so a stroke pushed outward is not clipped at the edge.
  const pad = Math.ceil(height * 0.03) + 2;
  const outWidth = width + pad * 2;
  const outHeight = height + pad * 2;
  const out = Buffer.alloc(outWidth * outHeight * 4, 0);

  // Shallow on purpose. At 5.5% the mark rippled; a hand drifts, it does not
  // undulate.
  const amplitude = height * 0.018;

  for (let y = 0; y < outHeight; y++) {
    const sy = y - pad;
    const v = sy / height;

    for (let x = 0; x < outWidth; x++) {
      const sx = x - pad;
      const u = sx / width;

      // Where in the source does this output pixel come from?
      let dx = 0;
      let dy = 0;
      for (const wave of params.waves) {
        dx += wave.ampX * Math.sin((u * wave.freqX + v * 0.35) * Math.PI * 2 + wave.phase);
        dy += wave.ampY * Math.sin((u * wave.freqY + v * 0.5) * Math.PI * 2 + wave.phase * 1.3);
      }

      const srcX = sx + dx * amplitude;
      const srcY = sy + dy * amplitude;

      if (srcX < 0 || srcY < 0 || srcX >= width - 1 || srcY >= height - 1) continue;

      // Bilinear sampling: nearest-neighbour would put the staircase back.
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const fx = srcX - x0;
      const fy = srcY - y0;

      const idx = (px: number, py: number) => (py * width + px) * 4;
      const i00 = idx(x0, y0);
      const i10 = idx(x0 + 1, y0);
      const i01 = idx(x0, y0 + 1);
      const i11 = idx(x0 + 1, y0 + 1);

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const o = (y * outWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = Math.round(
          data[i00 + c]! * w00 +
            data[i10 + c]! * w10 +
            data[i01 + c]! * w01 +
            data[i11 + c]! * w11,
        );
      }
    }
  }

  const warped = await sharp(out, { raw: { width: outWidth, height: outHeight, channels: 4 } })
    .png()
    .toBuffer();
  return new Uint8Array(warped);
};

/**
 * Apply one variation to a transparent PNG cutout.
 *
 * The alpha channel is preserved throughout: these images are stamped onto a
 * contract, and a variant that lost its transparency would paint a white box
 * over the document.
 */
export const applyVariant = async (
  png: Uint8Array,
  params: VariantParams,
): Promise<Uint8Array> => {
  try {
    // Bend first, then place: warping an already-rotated mark would fold the
    // wobble into the rotation and blur the letterforms.
    const warped = await elasticWarp(png, params);

    const source = sharp(Buffer.from(warped)).ensureAlpha();
    const meta = await source.metadata();
    if (!meta.width || !meta.height) {
      throw new HttpError(422, 'Image de signature illisible.', 'IMAGE_PROCESSING_FAILED');
    }

    const cos = Math.cos((params.rotate * Math.PI) / 180);
    const sin = Math.sin((params.rotate * Math.PI) / 180);
    const matrix: [number, number, number, number] = [
      cos * params.scale,
      -sin * params.scale + params.shear,
      sin * params.scale,
      cos * params.scale,
    ];

    let pipeline = source.affine(matrix, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      interpolator: sharp.interpolators.bilinear,
    });

    const placed = await pipeline.trim({ threshold: 1 }).png().toBuffer();

    /**
     * Weight and density carry most of the visible difference now.
     *
     * Two signings by the same hand differ mainly in how the pen was loaded and
     * how hard it was pressed: one comes out a touch fuller and darker, the
     * next thinner and drier. Both are applied to coverage, so the letterforms
     * are untouched — which is exactly what the wobble was failing to respect.
     */
    return new Uint8Array(await inkWeight(placed, params));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // A variant is a nicety: if it cannot be produced, the original still signs
    // the document correctly.
    return png;
  }
};

/**
 * The seed for variant number `index`.
 *
 * Deliberately depends on nothing but the index. The signer picks a variant by
 * looking at it, so the image they approved has to be the image that is
 * stamped — a seed mixing in the document or session id would generate
 * something else at signing time and quietly break that promise.
 */
export const variantSeed = (index: number): string => `variant:${index}`;

/**
 * How variant `index` sits on the page: its size, its position, its tilt.
 *
 * This is where the visible difference between two signings comes from, and it
 * had to move here to exist at all. Varying the cutout does not work — it is
 * trimmed to its ink and then fitted into its zone, and those two steps divide
 * out exactly a scale and a translation, which is why a model asking for 6.6%
 * of displacement delivered 0.5% to the paper. Applied to the placement,
 * nothing normalises it afterwards.
 *
 * The ranges are what a hand actually does: a few percent of size, a few
 * percent off the mark it was aiming for, a degree or two of tilt. Deterministic
 * in the index, like every other part of a variant, so the document can be
 * regenerated and come back identical.
 */
export const variantPlacement = (index: number, strength = 1): MarkVariation => {
  const digest = createHash('sha256').update(`placement:${index}`).digest();
  const unit = (i: number) => (digest[i % digest.length]! / 255) * 2 - 1;
  // Bounded hard: past this the mark stops looking like the same hand and
  // starts looking like a mark stamped carelessly.
  const k = Math.min(2.5, Math.max(0, strength));

  // A shared size change, plus a small independent one per axis: the mark comes
  // out a little bigger or smaller AND a little differently proportioned, which
  // is what reshapes the strokes.
  const size = 1 + unit(0) * 0.05 * k;
  return {
    scaleX: size * (1 + unit(4) * 0.035 * k),
    scaleY: size * (1 + unit(5) * 0.035 * k),
    offsetX: unit(1) * 0.045 * k,
    offsetY: unit(2) * 0.045 * k,
    tiltDegrees: unit(3) * 1.6 * k,
  };
};

/**
 * Variant `index` of a mark. Same index, same image, always.
 *
 * The Sigma-Lognormal engine is tried first: it recovers the pen trajectory,
 * decomposes the movement into ballistic strokes and perturbs those, which
 * re-signs the mark instead of re-filtering it. It returns null for anything it
 * cannot model — a mark too faint to skeletonise, a fragment, a stamp caught by
 * mistake — and then the affine + drift + pen filter still produces a perfectly
 * good variant. Falling back is silent on purpose: the signer is choosing
 * between pictures, not between engines.
 */
export const variantAt = async (png: Uint8Array, index: number): Promise<Uint8Array> => {
  if (env.SIGNATURE_VARIANT_ENGINE === 'sigma_lognormal') {
    const strength = env.SIGNATURE_VARIATION_STRENGTH;
    const synthesised = await synthesizeVariant(png, index, {
      penStrength: strength,
      range: {
        amplitude: DEFAULT_RANGE.amplitude * strength,
        timing: DEFAULT_RANGE.timing * strength,
        spread: DEFAULT_RANGE.spread * strength,
        angle: DEFAULT_RANGE.angle * strength,
        slant: DEFAULT_RANGE.slant * strength,
        size: DEFAULT_RANGE.size * strength,
      },
    });
    if (synthesised) return synthesised;
  }
  return applyVariant(png, variantParamsFor(variantSeed(index)));
};

/**
 * Vary the pen rather than the letterforms: stroke weight and ink density.
 *
 * Applied to the alpha channel only. Thickening dilates coverage a little and
 * deepens it; thinning erodes and lightens it. The shapes never move, so the
 * signature stays unmistakably the same one — the difference reads as a
 * different moment of writing, not a different signature.
 */
const inkWeight = async (png: Buffer, params: VariantParams): Promise<Buffer> =>
  Buffer.from(
    await applyInkWeight(new Uint8Array(png), {
      // Gamma on coverage: below 1 fattens the stroke, above 1 slims it.
      gamma: 1 - params.weight * 0.28,
      // Density multiplies the final opacity, within a range a real pen covers.
      density: 1 + params.density * 0.12,
    }),
  );

/**
 * A set of variants for the signer to look at and hand out to documents.
 * One per document, so a folder of four contracts is signed four times over.
 */
export const generateVariants = async (
  png: Uint8Array,
  count = 4,
): Promise<Array<{ index: number; dataUrl: string }>> => {
  const out: Array<{ index: number; dataUrl: string }> = [];
  for (let i = 0; i < count; i++) {
    const bytes = await variantAt(png, i);
    out.push({
      index: i,
      dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    });
  }
  return out;
};

/** Kept for callers that just want a spread to preview. */
export const previewVariants = generateVariants;

/**
 * Variant index for the `ordinal`-th zone of a mark on a document whose own
 * variant is `documentIndex`.
 *
 * The first zone keeps the document's variant — the one the operator saw and
 * approved. Later zones on the same document get indices from a range no
 * document index ever reaches, so two zones of one contract, and the zones of
 * two contracts, all differ. Deterministic, so a re-stamp reproduces it.
 */
export const zoneVariantIndex = (documentIndex: number, ordinal: number): number =>
  ordinal <= 0 ? documentIndex : 1000 + documentIndex * 32 + ordinal;

/**
 * One image per zone of a handwritten mark on this document — the base variant
 * first, a fresh one for every further zone. Undefined when a single zone (or
 * none) asks for the mark, or when variants are off: nothing to vary.
 */
export const variantsForZones = async (
  png: Uint8Array | null | undefined,
  mark: ZoneType,
  zoneCount: number,
  documentIndex: number | null,
  first: Uint8Array | null | undefined,
): Promise<Uint8Array[] | undefined> => {
  if (!png || !first || zoneCount <= 1 || documentIndex === null) return undefined;
  if (!env.SIGNATURE_VARIANTS || !HANDWRITTEN_MARKS.includes(mark)) return undefined;
  const out: Uint8Array[] = [first];
  for (let k = 1; k < zoneCount; k++) {
    out.push(await variantAt(png, zoneVariantIndex(documentIndex, k)));
  }
  return out;
};

/**
 * Fallback when the signer assigned nothing: give each document in the folder
 * its own variant.
 *
 * `ordinal` is the document's position in the folder, so the indices come out
 * 0, 1, 2, 3 — distinct by construction.
 *
 * This replaced a hash of the document id taken modulo the folder's size, and
 * the difference is not academic. Hashing n documents into n buckets collides
 * almost always: two documents land on the same index with probability 1/2 for
 * a pair, and all four stay distinct only 9% of the time for a folder of four.
 * Measured on real folders, three out of four carried duplicate variants — so
 * the folder that was signed to prove the variation worked came back with two
 * byte-identical signatures, which reads, correctly, as the feature not
 * working at all.
 *
 * Variation is worth having only if it is actually there on every document, so
 * the assignment must guarantee it rather than leave it to a hash.
 */
export const fallbackVariantIndex = (ordinal: number): number => Math.max(0, Math.trunc(ordinal));
