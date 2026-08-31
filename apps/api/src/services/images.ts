import sharp from 'sharp';
import type { NormalizedRect } from '@scansign/shared';
import { normalizedToPixelRect } from '@scansign/pdf';
import { HttpError } from '../lib/errors.js';
import { restoreInk } from './ink.js';

export interface NormalizedPhoto {
  bytes: Uint8Array;
  width: number;
  height: number;
  contentType: 'image/jpeg';
}

/**
 * Bake the EXIF orientation into the pixels and re-encode as JPEG.
 *
 * This matters more than it looks: an iPhone photo is stored landscape with an
 * "rotate me" EXIF tag. The phone displays the *rotated* image, so the region
 * the user draws is in rotated space. If the backend cropped the raw buffer the
 * signature would come out of the wrong corner. Normalising once, on upload,
 * means every later coordinate refers to the same pixels the user saw.
 */
export const normalizeCapturePhoto = async (input: Uint8Array): Promise<NormalizedPhoto> => {
  try {
    const pipeline = sharp(Buffer.from(input), { failOn: 'none' }).rotate();
    const { data, info } = await pipeline
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      width: info.width,
      height: info.height,
      contentType: 'image/jpeg',
    };
  } catch (cause) {
    throw new HttpError(
      400,
      "Cette photo n'a pas pu être lue.",
      'IMAGE_PROCESSING_FAILED',
      { cause: String(cause) },
    );
  }
};

/**
 * Crop a normalized 0..1 region out of a photo and return it as PNG.
 * PNG (not JPEG) because the crop goes straight into the extraction engine,
 * and JPEG ringing around ink strokes makes background removal worse.
 */
export const cropNormalizedRegion = async (
  photo: Uint8Array,
  rect: NormalizedRect,
  photoWidth: number,
  photoHeight: number,
): Promise<Uint8Array> => {
  const px = normalizedToPixelRect(rect, photoWidth, photoHeight);
  if (px.width < 8 || px.height < 8) {
    throw new HttpError(
      400,
      'La zone sélectionnée est trop petite. Recadrez plus largement.',
      'IMAGE_PROCESSING_FAILED',
    );
  }
  try {
    const out = await sharp(Buffer.from(photo), { failOn: 'none' })
      .extract({ left: px.x, top: px.y, width: px.width, height: px.height })
      .png()
      .toBuffer();
    return new Uint8Array(out);
  } catch (cause) {
    throw new HttpError(
      500,
      'Échec du recadrage de la zone sélectionnée.',
      'IMAGE_PROCESSING_FAILED',
      { cause: String(cause) },
    );
  }
};

/**
 * Trim fully transparent margins left by the extraction engine, so the cutout
 * fills the zone the operator drew instead of floating inside dead space.
 *
 * The alpha check is not redundant with the trim: `sharp.trim()` returns a
 * uniformly transparent image UNCHANGED rather than erroring, so without this
 * guard an extraction that found no ink would sail through and stamp an
 * invisible rectangle onto the contract. An empty cutout is a real failure and
 * has to be reported as one.
 */
export const trimTransparentBorder = async (
  png: Uint8Array,
  failureCode: string,
  { restore = true }: { restore?: boolean } = {},
): Promise<{ bytes: Uint8Array; width: number; height: number }> => {
  const noInk = () =>
    new HttpError(
      422,
      "Aucune trace d'encre détectée dans la zone sélectionnée.",
      failureCode,
    );

  let stats;
  try {
    stats = await sharp(Buffer.from(png)).ensureAlpha().stats();
  } catch (cause) {
    throw new HttpError(
      500,
      "Le résultat du détourage est illisible.",
      failureCode,
      { cause: String(cause) },
    );
  }

  const alpha = stats.channels[3];
  // max === 0 means every pixel is fully transparent: nothing was extracted.
  if (!alpha || alpha.max < 8) throw noInk();

  try {
    const { data, info } = await sharp(Buffer.from(png))
      .ensureAlpha()
      .trim({ threshold: 1 })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (info.width < 4 || info.height < 4) throw noInk();

    // Photographed ink keeps the grey value it had under the room's light, so
    // a cutout that is correct can still land on the contract looking washed
    // out. Re-inking happens here, after trimming, so every caller — the real
    // pipeline and the on-screen preview alike — sees the same result.
    if (!restore) {
      return { bytes: new Uint8Array(data), width: info.width, height: info.height };
    }

    const bytes = await restoreInk(new Uint8Array(data));
    // Restoration upscales, so the dimensions have to be re-read: reporting the
    // pre-restoration size would hand callers numbers that do not describe the
    // image they were given.
    const restored = await sharp(Buffer.from(bytes)).metadata();
    return {
      bytes,
      width: restored.width ?? info.width,
      height: restored.height ?? info.height,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // `trim` throws when the image is uniform — again, nothing was extracted.
    throw noInk();
  }
};

export const imageSize = async (
  bytes: Uint8Array,
): Promise<{ width: number; height: number }> => {
  const meta = await sharp(Buffer.from(bytes)).metadata();
  if (!meta.width || !meta.height) {
    throw new HttpError(400, 'Image illisible.', 'IMAGE_PROCESSING_FAILED');
  }
  return { width: meta.width, height: meta.height };
};
