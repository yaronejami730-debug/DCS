import { PDFDocument } from 'pdf-lib';
import { PdfPipelineError } from './errors.js';
import { normalizeRotation, type PageRotation } from './geometry.js';

export interface PdfPageInfo {
  /** 1-based, matching the page number a human sees. */
  page: number;
  /** Unrotated mediabox size, in points. */
  width: number;
  height: number;
  rotation: PageRotation;
}

export interface PdfInfo {
  pageCount: number;
  pages: PdfPageInfo[];
}

/** Parse a PDF far enough to know its page geometry. Throws INVALID_PDF. */
export const inspectPdf = async (bytes: Uint8Array): Promise<PdfInfo> => {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (cause) {
    throw new PdfPipelineError('INVALID_PDF', 'Impossible de lire ce fichier PDF.', { cause });
  }
  const pages = doc.getPages().map((page, i) => {
    const { width, height } = page.getSize();
    return {
      page: i + 1,
      width,
      height,
      rotation: normalizeRotation(page.getRotation().angle),
    };
  });
  if (pages.length === 0) {
    throw new PdfPipelineError('INVALID_PDF', 'Ce PDF ne contient aucune page.');
  }
  return { pageCount: pages.length, pages };
};

/** Cheap magic-number check before we bother parsing. */
export const looksLikePdf = (bytes: Uint8Array): boolean =>
  bytes.length > 4 &&
  bytes[0] === 0x25 && // %
  bytes[1] === 0x50 && // P
  bytes[2] === 0x44 && // D
  bytes[3] === 0x46 && // F
  bytes[4] === 0x2d; //  -
