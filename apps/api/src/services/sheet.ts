import sharp from 'sharp';
import {
  SHEET_DETECT_WORK_WIDTH,
  detectSheetInGrey,
  type SheetDetection,
} from '@scansign/shared';

export type { SheetDetection, SheetFieldDetection } from '@scansign/shared';

/**
 * Read a photographed capture sheet back into field rectangles.
 *
 * Decoding and downscaling happen here with sharp; the detection itself is the
 * pure core in @scansign/shared (`sheetDetect.ts`), shared with the signer's
 * browser so both sides read a sheet identically.
 */
export const detectSheet = async (photo: Uint8Array): Promise<SheetDetection | null> => {
  const { data, info } = await sharp(Buffer.from(photo), { failOn: 'none' })
    .resize({ width: SHEET_DETECT_WORK_WIDTH, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const grey = new Uint8Array(data.buffer, data.byteOffset, width * height);
  return detectSheetInGrey(grey, width, height);
};

/** Never let detection block the crop screen: without a sheet, the operator frames by hand. */
export const detectSheetSafely = async (photo: Uint8Array): Promise<SheetDetection | null> => {
  try {
    return await detectSheet(photo);
  } catch (error) {
    console.warn('[sheet] detection failed: %s', error);
    return null;
  }
};
