import sharp from 'sharp';
import type { NormalizedRect } from '@scansign/shared';

/**
 * Find the ink on a sheet of paper, so the phone can open its framing step with
 * the boxes already sitting on the signature and the stamp.
 *
 * This is deliberately not a vision API. The input is known and narrow — dark
 * or coloured ink on light paper — which makes it a thresholding problem, not a
 * recognition one. Doing it locally keeps it free, adds about 50ms instead of a
 * network round trip, and means photographs of customers' signatures never
 * leave the server.
 *
 * The result is only ever a *suggestion*: the user still adjusts and confirms
 * the boxes, so a poor detection costs a drag, never a wrong document.
 *
 * Pipeline:
 *   downscale -> greyscale -> adaptive threshold against the paper level
 *   -> dilate so separate pen strokes join into one mark
 *   -> label connected components -> discard noise and the sheet edge
 *   -> classify the two strongest as signature and stamp
 */

const WORK_WIDTH = 480;
/** Ignore blobs smaller than this share of the image — dust, JPEG noise. */
const MIN_MASS_RATIO = 0.0004;
/** A blob covering more than this is the sheet edge or a shadow, not a mark. */
const MAX_AREA_RATIO = 0.55;

export interface DetectedRegions {
  signature: NormalizedRect | null;
  stamp: NormalizedRect | null;
}

interface Blob {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Count of true ink pixels, not of dilated ones. */
  mass: number;
  /** Mean chroma of the ink, 0..255. Stamps are usually coloured. */
  chroma: number;
}

/** Value below which a pixel counts as ink, derived from the paper itself. */
const inkThreshold = (grey: Uint8Array): number => {
  const histogram = new Uint32Array(256);
  for (const value of grey) histogram[value]! += 1;

  // The paper is the bright bulk of the image: take a high percentile rather
  // than the max, so a specular highlight cannot drag the estimate up.
  const target = grey.length * 0.8;
  let seen = 0;
  let paper = 255;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen >= target) {
      paper = v;
      break;
    }
  }
  // Scale the margin with the paper level so a dim photo still works.
  return Math.max(24, paper - Math.max(30, Math.round(paper * 0.22)));
};

/**
 * Grow the mask by `radius` using two separable running sums — O(n) rather than
 * O(n·r²). Without this, the strokes of one signature label as a dozen
 * unrelated blobs.
 */
const dilate = (mask: Uint8Array, width: number, height: number, radius: number): Uint8Array => {
  if (radius <= 0) return mask;
  const horizontal = new Uint8Array(mask.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let running = 0;
    for (let x = 0; x < Math.min(radius, width); x++) running += mask[row + x]!;
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = running > 0 ? 1 : 0;
      const drop = x - radius;
      const add = x + radius + 1;
      if (drop >= 0) running -= mask[row + drop]!;
      if (add < width) running += mask[row + add]!;
    }
  }

  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let running = 0;
    for (let y = 0; y < Math.min(radius, height); y++) running += horizontal[y * width + x]!;
    for (let y = 0; y < height; y++) {
      out[y * width + x] = running > 0 ? 1 : 0;
      const drop = y - radius;
      const add = y + radius + 1;
      if (drop >= 0) running -= horizontal[drop * width + x]!;
      if (add < height) running += horizontal[add * width + x]!;
    }
  }
  return out;
};

/** Iterative flood fill — recursion would blow the stack on a large blob. */
const labelBlobs = (
  grouped: Uint8Array,
  ink: Uint8Array,
  chroma: Uint8Array,
  width: number,
  height: number,
): Blob[] => {
  const seen = new Uint8Array(grouped.length);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < grouped.length; start++) {
    if (grouped[start] === 0 || seen[start] === 1) continue;

    seen[start] = 1;
    stack.length = 0;
    stack.push(start);

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let mass = 0;
    let chromaSum = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (ink[index] === 1) {
        mass += 1;
        chromaSum += chroma[index]!;
      }

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (grouped[neighbour] === 1 && seen[neighbour] === 0) {
            seen[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }
    }

    if (mass > 0) {
      blobs.push({ minX, minY, maxX, maxY, mass, chroma: chromaSum / mass });
    }
  }
  return blobs;
};

const toRect = (blob: Blob, width: number, height: number): NormalizedRect => {
  // A little padding: the threshold clips the faintest edge of a pen stroke,
  // and the extraction engine copes far better with some paper around the ink.
  const padX = Math.max((blob.maxX - blob.minX) * 0.08, width * 0.012);
  const padY = Math.max((blob.maxY - blob.minY) * 0.08, height * 0.012);

  const x0 = Math.max(blob.minX - padX, 0) / width;
  const y0 = Math.max(blob.minY - padY, 0) / height;
  const x1 = Math.min(blob.maxX + padX, width - 1) / width;
  const y1 = Math.min(blob.maxY + padY, height - 1) / height;

  return {
    x: x0,
    y: y0,
    width: Math.min(Math.max(x1 - x0, 0.03), 1 - x0),
    height: Math.min(Math.max(y1 - y0, 0.03), 1 - y0),
  };
};

export const detectInkRegions = async (photo: Uint8Array): Promise<DetectedRegions> => {
  const { data, info } = await sharp(Buffer.from(photo), { failOn: 'none' })
    .resize({ width: WORK_WIDTH, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = width * height;
  const grey = new Uint8Array(pixels);
  const chroma = new Uint8Array(pixels);

  for (let i = 0; i < pixels; i++) {
    const o = i * channels;
    const r = data[o]!;
    const g = data[o + 1] ?? r;
    const b = data[o + 2] ?? r;
    grey[i] = (r * 299 + g * 587 + b * 114) / 1000;
    // Cheap saturation proxy: how far the channels spread apart.
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  const threshold = inkThreshold(grey);
  const ink = new Uint8Array(pixels);
  let inkCount = 0;
  for (let i = 0; i < pixels; i++) {
    if (grey[i]! < threshold) {
      ink[i] = 1;
      inkCount += 1;
    }
  }

  // Nothing written, or the whole frame is dark (a photo of a desk, a lens cap).
  if (inkCount < pixels * MIN_MASS_RATIO || inkCount > pixels * 0.6) {
    return { signature: null, stamp: null };
  }

  const grouped = dilate(ink, width, height, Math.max(2, Math.round(width * 0.022)));
  const blobs = labelBlobs(grouped, ink, chroma, width, height)
    .filter((blob) => {
      const area = (blob.maxX - blob.minX + 1) * (blob.maxY - blob.minY + 1);
      if (blob.mass < pixels * MIN_MASS_RATIO) return false;
      if (area > pixels * MAX_AREA_RATIO) return false;
      // A blob hugging every edge is the sheet border or a shadow.
      const hugsAllEdges =
        blob.minX <= 1 && blob.minY <= 1 && blob.maxX >= width - 2 && blob.maxY >= height - 2;
      return !hugsAllEdges;
    })
    .sort((a, b) => b.mass - a.mass);

  if (blobs.length === 0) return { signature: null, stamp: null };
  if (blobs.length === 1) {
    return { signature: toRect(blobs[0]!, width, height), stamp: null };
  }

  const [first, second] = [blobs[0]!, blobs[1]!];
  const aspect = (blob: Blob) => (blob.maxX - blob.minX + 1) / Math.max(blob.maxY - blob.minY + 1, 1);

  // A handwritten signature runs wide; a stamp is close to square and usually
  // coloured. Shape decides when it is clear-cut, colour breaks the tie.
  let signatureBlob = first;
  let stampBlob = second;
  const aspectGap = aspect(first) - aspect(second);
  if (Math.abs(aspectGap) > 0.4) {
    if (aspectGap < 0) {
      signatureBlob = second;
      stampBlob = first;
    }
  } else if (second.chroma < first.chroma) {
    signatureBlob = second;
    stampBlob = first;
  }

  return {
    signature: toRect(signatureBlob, width, height),
    stamp: toRect(stampBlob, width, height),
  };
};

/** Never let a detection failure block a capture: the user can always frame it. */
export const detectInkRegionsSafely = async (photo: Uint8Array): Promise<DetectedRegions> => {
  try {
    return await detectInkRegions(photo);
  } catch (error) {
    console.warn('[detect] ink detection failed: %s', error);
    return { signature: null, stamp: null };
  }
};
