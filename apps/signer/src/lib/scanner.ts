import { scanDocument } from 'scanic';

/**
 * Turn a phone photo of a signed page into a clean, deskewed scan.
 *
 * The technician holds the page at an angle under whatever light is around, and
 * a raw photo — tilted, with the desk in the frame — makes the operator's
 * cropping harder and the extraction worse. scanic finds the paper's four
 * corners and warps them square, the way a scanner app does, entirely on the
 * device: no upload, no third party seeing the document, and a self-contained
 * Rust/WASM core rather than an 8MB OpenCV download.
 *
 * It is best-effort. When no clear document boundary is found — a page that
 * fills the frame, a busy background, poor contrast — the original photo is
 * returned untouched. A worse crop than none is not worth forcing, and the
 * operator can always work from the original.
 */
const MAX_EDGE = 2400;
const JPEG_QUALITY = 0.92;

/** Decode a File/Blob to an <img>, so scanic and canvas can read its pixels. */
const toImage = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image illisible'));
    };
    img.src = url;
  });

/** A canvas as a bounded JPEG blob, matching what the plain upload path sends. */
const canvasToJpeg = (canvas: HTMLCanvasElement): Promise<Blob> => {
  const scale = Math.min(1, MAX_EDGE / Math.max(canvas.width, canvas.height));
  const target =
    scale === 1
      ? canvas
      : (() => {
          const c = document.createElement('canvas');
          c.width = Math.round(canvas.width * scale);
          c.height = Math.round(canvas.height * scale);
          c.getContext('2d')?.drawImage(canvas, 0, 0, c.width, c.height);
          return c;
        })();
  return new Promise((resolve, reject) => {
    target.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('encodage impossible'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
};

export interface ScanOutcome {
  blob: Blob;
  /** True when a document boundary was found and the image was straightened. */
  scanned: boolean;
}

export const scanToDocument = async (source: Blob): Promise<ScanOutcome> => {
  try {
    const image = await toImage(source);
    const result = await scanDocument(image, { mode: 'extract', output: 'canvas' });
    if (result.success && result.output instanceof HTMLCanvasElement) {
      return { blob: await canvasToJpeg(result.output), scanned: true };
    }
  } catch {
    // WASM refused to load, an odd image, a detector throw — none of it should
    // cost the technician their upload.
  }
  return { blob: source, scanned: false };
};
