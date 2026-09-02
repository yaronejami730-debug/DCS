/**
 * Cheap photo-quality signals, computed on a small greyscale copy.
 *
 * These drive the green/amber/red indicators the signer sees before sending a
 * page: is it sharp, is it lit, is the sheet in frame. They are heuristics
 * tuned for paper under everyday light, not a general image-quality model, and
 * every threshold below was chosen so that a photo a person would call fine
 * shows green.
 *
 * Pure functions over a `Uint8Array` of grey values, so the same numbers come
 * out on the API (sharp) and in the browser (canvas).
 */

export type QualityLevel = 'ok' | 'warn' | 'bad';

export interface ExposureReport {
  /** Mean luminance 0..255. */
  mean: number;
  /** Share of pixels that are essentially white (blown out). */
  clippedHigh: number;
  /** Share of pixels that are essentially black. */
  clippedLow: number;
  level: QualityLevel;
}

export interface SharpnessReport {
  /**
   * Variance of a Laplacian over the image, normalised by contrast so a pale
   * page and a dark desk are judged on the same scale. Bigger is sharper.
   */
  score: number;
  level: QualityLevel;
}

/**
 * Downscale a grey image to about `targetWidth` by box averaging — the caller
 * hands us whatever size it has, and the metrics want a consistent scale so
 * their thresholds mean the same thing on every phone.
 */
export const downscaleGrey = (
  grey: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
): { grey: Uint8Array; width: number; height: number } => {
  const factor = Math.max(1, Math.floor(width / targetWidth));
  if (factor === 1) return { grey, width, height };
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8Array(w * h);
  const area = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const baseY = y * factor;
      const baseX = x * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (baseY + dy) * width + baseX;
        for (let dx = 0; dx < factor; dx++) sum += grey[row + dx]!;
      }
      out[y * w + x] = sum / area;
    }
  }
  return { grey: out, width: w, height: h };
};

/** Luminance of an RGBA buffer, one byte per pixel out. */
export const rgbaToGrey = (rgba: Uint8ClampedArray | Uint8Array, pixels: number): Uint8Array => {
  const grey = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    grey[i] = (rgba[o]! * 299 + rgba[o + 1]! * 587 + rgba[o + 2]! * 114) / 1000;
  }
  return grey;
};

export const assessExposure = (grey: Uint8Array): ExposureReport => {
  let sum = 0;
  let high = 0;
  let low = 0;
  for (const v of grey) {
    sum += v;
    if (v >= 250) high += 1;
    else if (v <= 8) low += 1;
  }
  const n = grey.length || 1;
  const mean = sum / n;
  const clippedHigh = high / n;
  const clippedLow = low / n;
  // Paper photographed in a room lands around 140–230. Below ~90 the ink and
  // the paper start to merge; a large blown-out share means a flash or a
  // window has erased strokes.
  let level: QualityLevel = 'ok';
  if (mean < 70 || mean > 245 || clippedHigh > 0.45) level = 'bad';
  else if (mean < 95 || clippedHigh > 0.25 || clippedLow > 0.35) level = 'warn';
  return { mean, clippedHigh, clippedLow, level };
};

/**
 * Sharpness as the variance of a 3×3 Laplacian, divided by the image's
 * contrast (standard deviation) so it is not simply "how much ink is there".
 * Expects a ~400px-wide image: the thresholds are calibrated for that.
 */
export const assessSharpness = (grey: Uint8Array, width: number, height: number): SharpnessReport => {
  if (width < 3 || height < 3) return { score: 0, level: 'bad' };
  let mean = 0;
  for (const v of grey) mean += v;
  mean /= grey.length;
  let variance = 0;
  for (const v of grey) variance += (v - mean) * (v - mean);
  const stdev = Math.sqrt(variance / grey.length) || 1;

  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap =
        4 * grey[i]! - grey[i - 1]! - grey[i + 1]! - grey[i - width]! - grey[i + width]!;
      lapSum += lap;
      lapSq += lap * lap;
      count += 1;
    }
  }
  const lapMean = lapSum / count;
  const lapVar = lapSq / count - lapMean * lapMean;
  // Normalised by contrast: a blurry high-contrast page and a sharp low-contrast
  // one should not trade places.
  const score = Math.sqrt(Math.max(lapVar, 0)) / stdev;
  let level: QualityLevel = 'ok';
  if (score < 0.12) level = 'bad';
  else if (score < 0.2) level = 'warn';
  return { score, level };
};
