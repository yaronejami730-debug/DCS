import * as pdfjs from 'pdfjs-dist';
import { detectSheetInGrey, rgbaToGrey, type SheetDetection } from '@scansign/shared';

/**
 * Open a returned scan on the page that carries the printed capture sheet, and
 * hand back the sheet's boxes with it.
 *
 * The attestation is two pages — identity first, the sheet second — and a
 * technician who scans the whole thing sends both. Opening on page 1 showed a
 * page with no markers and looked like the detection had failed.
 *
 * Speed is the design constraint here: the operator is waiting on a spinner.
 *   1. one download of the PDF;
 *   2. a LIGHT render (~850px) of each candidate page, just enough for the
 *      detector — the same one the API runs — to say "sheet" or "not";
 *   3. ONE heavy render, of the chosen page, at the resolution the crop needs.
 * The detection made in step 2 is returned as-is: its rectangles are
 * normalized, so they are valid on the heavy render too, and the crop screen
 * can draw every box the instant the image appears, without a server round
 * trip.
 */

/** Display scale: the extraction engine works on the crop, and a signature a tenth of an A4 page wide needs the pixels. */
const DISPLAY_SCALE = 2;
/** Width the detector runs at; enough for 9pt markers to be ~12px. */
const DETECT_WIDTH = 850;
const JPEG_QUALITY = 0.92;
const MAX_SEARCHED = 6;

export interface OpenedScanPage {
  page: number;
  blob: Blob;
  width: number;
  height: number;
  /** The capture sheet found on this page, when there is one. */
  sheet: SheetDetection | null;
}

const toJpeg = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encodage impossible'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });

/** Run the sheet detector on whatever is drawn on this canvas. */
export const detectSheetOnCanvas = (canvas: HTMLCanvasElement): SheetDetection | null => {
  const scale = Math.min(1, DETECT_WIDTH / canvas.width);
  let source = canvas;
  if (scale < 1) {
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(canvas.width * scale));
    small.height = Math.max(1, Math.round(canvas.height * scale));
    small.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height);
    source = small;
  }
  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const { data } = context.getImageData(0, 0, source.width, source.height);
  try {
    return detectSheetInGrey(rgbaToGrey(data, source.width * source.height), source.width, source.height);
  } catch {
    return null;
  }
};

/** Detect the sheet on an already-decoded image (a photo return). */
export const detectSheetOnImage = (image: CanvasImageSource, width: number, height: number) => {
  const scale = Math.min(1, DETECT_WIDTH / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d', { willReadFrequently: true })?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return detectSheetOnCanvas(canvas);
};

const renderPage = async (
  doc: pdfjs.PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<HTMLCanvasElement> => {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas indisponible');
  // White behind the page: a PDF renders transparent, and a transparent JPEG
  // becomes black, against which no ink is findable.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas;
};

/**
 * Render `preferred` — or, when `search` is on and it is not a sheet, the first
 * page that is. Returns the heavy render of the chosen page plus its detection.
 */
export const openScanPage = async (
  url: string,
  preferred: number,
  options: { search: boolean; pageCount: number; onStep?: (label: string) => void },
): Promise<OpenedScanPage> => {
  const t0 = performance.now();
  options.onStep?.('Téléchargement du scan…');
  const doc = await pdfjs.getDocument({ url }).promise;
  const tDownload = performance.now();
  const total = Math.min(options.pageCount || doc.numPages, doc.numPages);
  const first = Math.min(Math.max(preferred, 1), total);
  const lightScale = DETECT_WIDTH / (await doc.getPage(first)).getViewport({ scale: 1 }).width;

  // Light pass: which page is the sheet?
  options.onStep?.('Recherche des repères…');
  let chosen = first;
  let looked = 1;
  let sheet = detectSheetOnCanvas(await renderPage(doc, first, lightScale));
  if (!sheet && options.search && total > 1) {
    const limit = Math.min(total, MAX_SEARCHED);
    for (let p = 1; p <= limit; p++) {
      if (p === first) continue;
      looked += 1;
      const found = detectSheetOnCanvas(await renderPage(doc, p, lightScale));
      if (found) {
        chosen = p;
        sheet = found;
        break;
      }
    }
  }
  const tDetect = performance.now();

  // Heavy pass: the one page the operator will crop from.
  options.onStep?.('Rendu de la page…');
  const canvas = await renderPage(doc, chosen, DISPLAY_SCALE);
  const blob = await toJpeg(canvas);
  const tRender = performance.now();
  // Where the wait goes, for whoever is asked "why is this slow".
  console.info(
    '[crop] ouverture: téléchargement %d ms · détection %d ms (%d page%s) · rendu %d ms · total %d ms',
    Math.round(tDownload - t0),
    Math.round(tDetect - tDownload),
    looked,
    looked > 1 ? 's' : '',
    Math.round(tRender - tDetect),
    Math.round(tRender - t0),
  );
  return { page: chosen, blob, width: canvas.width, height: canvas.height, sheet };
};
