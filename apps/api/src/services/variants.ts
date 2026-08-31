import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { HttpError } from '../lib/errors.js';

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

/** Variant `index` of a mark. Same index, same image, always. */
export const variantAt = async (png: Uint8Array, index: number): Promise<Uint8Array> =>
  applyVariant(png, variantParamsFor(variantSeed(index)));

/**
 * Vary the pen rather than the letterforms: stroke weight and ink density.
 *
 * Applied to the alpha channel only. Thickening dilates coverage a little and
 * deepens it; thinning erodes and lightens it. The shapes never move, so the
 * signature stays unmistakably the same one — the difference reads as a
 * different moment of writing, not a different signature.
 */
const inkWeight = async (png: Buffer, params: VariantParams): Promise<Buffer> => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) return png;

  // Gamma on coverage: below 1 fattens the stroke, above 1 slims it.
  const gamma = 1 - params.weight * 0.28;
  // Density multiplies the final opacity, within a range a real pen covers.
  const density = 1 + params.density * 0.12;

  const out = Buffer.from(data);
  for (let i = 3; i < out.length; i += 4) {
    const alpha = out[i]!;
    if (alpha === 0) continue;
    const shaped = Math.pow(alpha / 255, gamma) * density;
    out[i] = Math.min(255, Math.max(0, Math.round(shaped * 255)));
  }

  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
};

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
 * Fallback when the signer assigned nothing: derive a stable index from the
 * document, so documents in a folder still differ from one another.
 */
export const fallbackVariantIndex = (documentId: string, count: number): number => {
  const digest = createHash('sha256').update(documentId).digest();
  return digest[0]! % Math.max(1, count);
};
