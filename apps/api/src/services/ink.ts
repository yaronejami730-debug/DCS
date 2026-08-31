import sharp from 'sharp';

/**
 * Make photographed ink look like ink again.
 *
 * A signature photographed on a desk is rarely black on white: it is mid-grey
 * on beige, under a shadow, at whatever exposure the phone chose. Background
 * removal cuts the paper away correctly but leaves the strokes at the grey
 * value they had in the photo, so the mark lands on the contract looking
 * washed out beside the printed text. Measured on a dim capture, extracted ink
 * came out at luminance 72 of 255 — visibly pale.
 *
 * Nothing here invents strokes. It darkens ink that is already present and
 * firms up the alpha that background removal leaves partial along stroke
 * edges. Hue is preserved on purpose: a blue pen must stay blue.
 */

/**
 * NOTE — pre-normalising the crop before extraction was tried and removed.
 *
 * Stretching the crop to full range looks like it should help a dim photo, and
 * it does make the ink darker to the eye. But it also flattens the paper into a
 * near-uniform white with sharpening noise on top, and the engine's own
 * threshold analysis then finds no separation at all: measured on a dim
 * fixture, the raw photo cut out cleanly at 98.5% transparent while the
 * "enhanced" one removed nothing. The engine analyses the real photo better
 * than a pre-processed one, so it gets the real photo.
 *
 * The washed-out look is fixed after extraction instead, where the background
 * is already gone and only the strokes are touched.
 */

/**
 * Minimum width a cutout is scaled up to before it is stamped.
 *
 * A framed region is often only a few hundred pixels across, and the engine
 * thresholds hard, so the alpha mask comes back almost binary: measured on a
 * real capture, only 1.2% of pixels had partial alpha. A binary mask is a
 * staircase, and the staircase is what reads as pixelation once the image is
 * scaled into a zone on the page.
 *
 * Upscaling with Lanczos before stamping does two things: it gives the PDF more
 * pixels to render from, and the kernel itself interpolates the mask edge into
 * a real gradient. 1400px is comfortably above what any signature zone needs at
 * print resolution while keeping the PNG small.
 */
const SMOOTH_TARGET_WIDTH = 1400;

export interface InkRestoreOptions {
  /**
   * How far to close the gap to `target`, 0..1. Below 1 on purpose: pushing
   * all the way flattens the pen's texture into one flat colour.
   */
  strength?: number;
  /** Mean ink luminance to aim for, 0 = black. */
  target?: number;
  /** Upscale and soften the mask edge. Off for measurements and tests. */
  smooth?: boolean;
}

/**
 * Turn a hard-thresholded mask into a smooth one.
 *
 * The engine's own `smoothing` option was tried first and rejected: at every
 * level above zero it blurs the whole mark rather than its edge, dropping mean
 * opacity from 246 to 63 and luminance from 72 to 159 — the washed-out problem
 * back again, worse. So the engine is left crisp and the edge is treated here,
 * where the blur can be confined to the alpha channel and never touches the
 * ink's colour or the solid interior of a stroke.
 */
export const smoothEdges = async (png: Uint8Array): Promise<Uint8Array> => {
  try {
    const first = await sharp(Buffer.from(png))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (first.info.channels !== 4) return png;

    /**
     * Flatten the strokes to the pen's own colour before resampling.
     *
     * A cutout stores black in the RGB of its transparent pixels, and any
     * resample mixes those into the stroke edges: measured, lanczos took ink
     * from luminance 47 to 0 and turned a coloured pen black. Rather than
     * fight the bleed, the ink is set to one colour — the mean of its most
     * opaque pixels, so the real hue is kept — and only coverage is allowed to
     * vary. Nothing can bleed into a uniform field, and a pen laid down in one
     * colour is what a signature actually looks like.
     */
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < first.data.length; i += 4) {
      if (first.data[i + 3]! < 200) continue;
      r += first.data[i]!;
      g += first.data[i + 1]!;
      b += first.data[i + 2]!;
      n += 1;
    }
    if (n === 0) return png;
    const ink = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };

    const flattened = Buffer.from(first.data);
    for (let i = 0; i < flattened.length; i += 4) {
      flattened[i] = ink.r;
      flattened[i + 1] = ink.g;
      flattened[i + 2] = ink.b;
    }

    const scale = Math.min(4, Math.max(1, SMOOTH_TARGET_WIDTH / first.info.width));
    // Both dimensions must be given: passing width alone leaves the height
    // unchanged and stretches the signature.
    const resized =
      scale > 1.05
        ? await sharp(flattened, {
            raw: { width: first.info.width, height: first.info.height, channels: 4 },
          })
            .resize({
              width: Math.round(first.info.width * scale),
              height: Math.round(first.info.height * scale),
              kernel: 'lanczos3',
              fit: 'fill',
            })
            .raw()
            .toBuffer({ resolveWithObject: true })
        : { data: flattened, info: first.info };

    // Soften coverage only. Doing this with removeAlpha() + joinChannel() was
    // tried and is wrong: removeAlpha composites onto black first, which
    // destroys the ink's colour.
    const { data, info } = resized;
    const alphaOnly = Buffer.alloc(info.width * info.height);
    for (let p = 0, i = 3; i < data.length; i += 4, p += 1) alphaOnly[p] = data[i]!;

    /**
     * `toColourspace('b-w')` is required, not decorative. Given a 1-channel raw
     * input sharp returns THREE channels by default, so reading the result with
     * a stride of 1 lands on arbitrary bytes: it silently reduced a signature
     * to 0.1% of its pixels. Pinning the output to greyscale keeps one byte per
     * pixel, which is what the loop below assumes.
     */
    const blurred = await sharp(alphaOnly, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .blur(Math.max(0.6, scale * 0.5))
      .toColourspace('b-w')
      .raw()
      .toBuffer();

    if (blurred.length !== info.width * info.height) {
      // Refuse to index a buffer whose shape is not what we assume.
      return new Uint8Array(png);
    }

    const out = Buffer.from(data);
    for (let p = 0, i = 0; i < out.length; i += 4, p += 1) {
      // Resampling a uniform field cannot shift the colour, but it can leave
      // rounding drift; reassert the exact ink colour.
      out[i] = ink.r;
      out[i + 1] = ink.g;
      out[i + 2] = ink.b;
      out[i + 3] = blurred[p]!;
    }

    const smoothed = await sharp(out, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    return new Uint8Array(smoothed);
  } catch {
    // Smoothing is an improvement, not a requirement.
    return png;
  }
};

export const restoreInk = async (
  png: Uint8Array,
  { strength = 0.8, target = 40, smooth = true }: InkRestoreOptions = {},
): Promise<Uint8Array> => {
  try {
    const image = sharp(Buffer.from(png)).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return png;

    const out = Buffer.from(data);
    const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

    /**
     * Key the correction off the MEAN luminance of the ink, not the darkest
     * pixel. Anti-aliasing puts a near-black pixel in almost any stroke, so the
     * minimum says nothing about how the mark reads; the average is exactly
     * what looks washed out. An early version keyed off the minimum and moved
     * a pale capture from 72 to 65 — no visible change.
     */
    let inkPixels = 0;
    let luminanceSum = 0;
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3]! < 128) continue;
      inkPixels += 1;
      luminanceSum += out[i]! * 0.299 + out[i + 1]! * 0.587 + out[i + 2]! * 0.114;
    }
    if (inkPixels === 0) return png;

    const mean = luminanceSum / inkPixels;
    // Already dark enough: leave a black pen alone rather than crushing it.
    const factor = mean > target ? Math.max(0, 1 - ((mean - target) / mean) * strength) : 1;

    for (let i = 0; i < out.length; i += 4) {
      const alpha = out[i + 3]!;
      if (alpha === 0) continue;

      // Raise partial coverage gently. An earlier gamma of 0.6 pushed the few
      // partial pixels straight to opaque, which destroyed the little
      // anti-aliasing the mask had and made the edges visibly jagged. 0.85
      // firms up faded strokes while leaving the edge gradient intact for
      // smoothEdges to work with.
      out[i + 3] = clamp(Math.pow(alpha / 255, 0.85) * 255);

      if (factor < 1) {
        // Same factor on every channel: darkens without shifting hue, so a
        // blue pen stays blue instead of turning black.
        out[i] = clamp(out[i]! * factor);
        out[i + 1] = clamp(out[i + 1]! * factor);
        out[i + 2] = clamp(out[i + 2]! * factor);
      }
    }

    const restored = await sharp(out, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();

    return smooth ? smoothEdges(new Uint8Array(restored)) : new Uint8Array(restored);
  } catch {
    // Restoration is an improvement, not a requirement: a failure here must
    // still leave a usable cutout.
    return png;
  }
};

/** Mean luminance and opacity of the ink — used by tests and diagnostics. */
export const inkStats = async (
  png: Uint8Array,
): Promise<{ luminance: number; opacity: number; pixels: number }> => {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let pixels = 0;
  let luminanceSum = 0;
  let alphaSum = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const alpha = data[i + 3]!;
    if (alpha < 24) continue;
    pixels += 1;
    luminanceSum += data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114;
    alphaSum += alpha;
  }
  return {
    luminance: pixels ? luminanceSum / pixels : 255,
    opacity: pixels ? alphaSum / pixels : 0,
    pixels,
  };
};
