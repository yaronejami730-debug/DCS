import {
  SHEET_DETECT_WORK_WIDTH,
  assessExposure,
  assessSharpness,
  detectSheetInGrey,
  downscaleGrey,
  rgbaToGrey,
  type ExposureReport,
  type QualityLevel,
  type SharpnessReport,
  type SheetDetection,
} from '@scansign/shared';

/**
 * The "sensors" on a photo: sharp, lit, framed.
 *
 * Everything runs on the device, on a small greyscale copy drawn from a canvas,
 * so a live viewfinder can be judged several times a second and a chosen file
 * in well under a second. The same shared functions run on the API, so what
 * shows green here is what the server will read cleanly.
 */

export interface PhotoQuality {
  sharpness: SharpnessReport;
  exposure: ExposureReport;
  /** The printed capture sheet, when its markers were all found. */
  sheet: SheetDetection | null;
  /** Worst of the levels that matter for a usable page. */
  overall: QualityLevel;
}

/** Sizes the metrics were calibrated for. */
const METRIC_WIDTH = 400;
/** Full-resolution detection for a chosen file; the live view uses less. */
const SHEET_WIDTH_STILL = SHEET_DETECT_WORK_WIDTH;
const SHEET_WIDTH_LIVE = 640;

const greyOf = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
): { grey: Uint8Array; width: number; height: number } | null => {
  const scale = Math.min(1, targetWidth / Math.max(sourceWidth, 1));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  return { grey: rgbaToGrey(data, width * height), width, height };
};

const worst = (...levels: QualityLevel[]): QualityLevel =>
  levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok';

const assess = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  sheetWidth: number,
): PhotoQuality | null => {
  const big = greyOf(source, sourceWidth, sourceHeight, sheetWidth);
  if (!big) return null;
  const small = downscaleGrey(big.grey, big.width, big.height, METRIC_WIDTH);
  const sharpness = assessSharpness(small.grey, small.width, small.height);
  const exposure = assessExposure(small.grey);
  let sheet: SheetDetection | null = null;
  try {
    sheet = detectSheetInGrey(big.grey, big.width, big.height);
  } catch {
    sheet = null;
  }
  return { sharpness, exposure, sheet, overall: worst(sharpness.level, exposure.level) };
};

/** Judge one frame of a live <video>. Cheap enough to call a few times a second. */
export const assessVideoFrame = (video: HTMLVideoElement): PhotoQuality | null => {
  if (!video.videoWidth || !video.videoHeight) return null;
  return assess(video, video.videoWidth, video.videoHeight, SHEET_WIDTH_LIVE);
};

/** Judge a chosen or captured photo, at full detection resolution. */
export const assessPhoto = async (blob: Blob): Promise<PhotoQuality | null> => {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (bitmap) {
    try {
      return assess(bitmap, bitmap.width, bitmap.height, SHEET_WIDTH_STILL);
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('image illisible'));
      element.src = url;
    });
    return assess(image, image.naturalWidth, image.naturalHeight, SHEET_WIDTH_STILL);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** What each sensor says, in the signer's words. */
export const describeSharpness = (r: SharpnessReport): string =>
  r.level === 'ok' ? 'Nette' : r.level === 'warn' ? 'Un peu floue' : 'Floue';

export const describeExposure = (r: ExposureReport): string =>
  r.level === 'ok'
    ? 'Bien éclairée'
    : r.mean < 95
      ? 'Trop sombre'
      : r.clippedHigh > 0.25
        ? 'Trop de lumière'
        : 'Éclairage moyen';

export const describeSheet = (sheet: SheetDetection | null): string => {
  if (!sheet) return 'Feuille non reconnue';
  const complete = sheet.fields.filter((f) => f.markersFound === 4).length;
  return `Feuille reconnue · ${complete}/${sheet.fields.length} cases`;
};
