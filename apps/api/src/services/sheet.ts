import sharp from 'sharp';
import {
  CAPTURE_SHEET_LAYOUTS,
  SHEET_DETECT_WORK_WIDTH,
  detectSheetInGrey,
  type CaptureSheetLayout,
  type SheetDetection,
} from '@scansign/shared';
import { loadOwnerCaptureSheetLayout } from './sheetFields.js';

export type { SheetDetection, SheetFieldDetection } from '@scansign/shared';

/**
 * Read a photographed capture sheet back into field rectangles.
 *
 * Decoding and downscaling happen here with sharp; the detection itself is the
 * pure core in @scansign/shared (`sheetDetect.ts`), shared with the signer's
 * browser so both sides read a sheet identically. `layouts` defaults to the
 * built-in sheet for a caller with no owner in scope; pass the owner's own
 * (DB-backed) layout whenever one is known — see `loadOwnerCaptureSheetLayout`.
 */
export const detectSheet = async (
  photo: Uint8Array,
  layouts: readonly CaptureSheetLayout[] = CAPTURE_SHEET_LAYOUTS,
): Promise<SheetDetection | null> => {
  const { data, info } = await sharp(Buffer.from(photo), { failOn: 'none' })
    .resize({ width: SHEET_DETECT_WORK_WIDTH, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const grey = new Uint8Array(data.buffer, data.byteOffset, width * height);
  return detectSheetInGrey(grey, width, height, layouts);
};

/** Never let detection block the crop screen: without a sheet, the operator frames by hand. */
export const detectSheetSafely = async (
  photo: Uint8Array,
  layouts?: readonly CaptureSheetLayout[],
): Promise<SheetDetection | null> => {
  try {
    return await detectSheet(photo, layouts);
  } catch (error) {
    console.warn('[sheet] detection failed: %s', error);
    return null;
  }
};

/** Convenience: the owner's own layout, ready to pass to `detectSheet(Safely)`. */
export const detectSheetForOwner = async (
  photo: Uint8Array,
  ownerId: string,
): Promise<SheetDetection | null> => {
  const layout = await loadOwnerCaptureSheetLayout(ownerId);
  return detectSheetSafely(photo, [layout]);
};
