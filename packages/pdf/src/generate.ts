import { PDFDocument, degrees } from 'pdf-lib';
import type { ErrorCode, NormalizedRect, ZoneType } from '@scansign/shared';
import { PdfPipelineError } from './errors.js';
import { computeImagePlacement, normalizeRotation } from './geometry.js';

export interface PlacementZone {
  /** 1-based page number. */
  page: number;
  type: ZoneType;
  /** Normalized viewport rect, origin top-left. */
  rect: NormalizedRect;
}

export interface GenerateSignedPdfInput {
  /** Bytes of the ORIGINAL document. Never mutated — pdf-lib works on a copy. */
  pdfBytes: Uint8Array;
  zones: PlacementZone[];
  /** Transparent PNG cutout of the signature. Required if a signature zone exists. */
  signaturePng?: Uint8Array | null;
  /** Transparent PNG cutout of the stamp. Required if a stamp zone exists. */
  stampPng?: Uint8Array | null;
  /** Transparent PNG of the "Lu et approuvé" mention, if a zone asks for one. */
  mentionPng?: Uint8Array | null;
  /** Signature and stamp captured together as one mark. */
  combinedPng?: Uint8Array | null;
}

export interface GenerateSignedPdfResult {
  bytes: Uint8Array;
  /** How many zones were actually stamped. */
  placed: number;
}

/**
 * Stamp the signature/stamp cutouts onto a copy of the original PDF.
 *
 * Guarantees:
 *  - the input buffer is never modified (pdf-lib parses into a new document);
 *  - every zone is validated against the real page count before anything is drawn,
 *    so a bad template fails cleanly instead of producing a half-signed document;
 *  - images keep their aspect ratio and are centred inside the drawn zone;
 *  - rotated pages (/Rotate 90|180|270) are handled, including spinning the
 *    stamped image so it reads upright.
 */
export const generateSignedPdf = async (
  input: GenerateSignedPdfInput,
): Promise<GenerateSignedPdfResult> => {
  const { pdfBytes, zones } = input;

  if (zones.length === 0) {
    throw new PdfPipelineError(
      'TEMPLATE_NOT_FOUND',
      'Aucune zone de signature définie pour ce document.',
    );
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (cause) {
    throw new PdfPipelineError('INVALID_PDF', 'Impossible de lire ce fichier PDF.', { cause });
  }

  const pages = doc.getPages();

  // Validate the whole template before drawing anything.
  for (const zone of zones) {
    if (!Number.isInteger(zone.page) || zone.page < 1 || zone.page > pages.length) {
      throw new PdfPipelineError(
        'TEMPLATE_ZONE_OUT_OF_RANGE',
        `Le template vise la page ${zone.page}, or le document en compte ${pages.length}.`,
      );
    }
    const { x, y, width, height } = zone.rect;
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > 1.001 || y + height > 1.001) {
      throw new PdfPipelineError(
        'TEMPLATE_ZONE_OUT_OF_RANGE',
        `Une zone ${zone.type} de la page ${zone.page} sort du document.`,
      );
    }
  }

  // Check every required cutout up front: a document must never come out with
  // one mark placed and another silently missing.
  const required: Array<[ZoneType, Uint8Array | null | undefined, ErrorCode, string]> = [
    ['signature', input.signaturePng, 'SIGNATURE_EXTRACTION_FAILED', 'une signature'],
    ['stamp', input.stampPng, 'STAMP_EXTRACTION_FAILED', 'un tampon'],
    ['mention', input.mentionPng, 'MENTION_EXTRACTION_FAILED', 'la mention « Lu et approuvé »'],
    ['signature_stamp', input.combinedPng, 'COMBINED_EXTRACTION_FAILED', 'un tampon signé'],
  ];
  for (const [type, bytes, code, label] of required) {
    if (zones.some((z) => z.type === type) && !bytes?.length) {
      throw new PdfPipelineError(
        code,
        `Le document attend ${label} mais aucune image détourée n’est disponible.`,
      );
    }
  }

  const embedded: Record<ZoneType, Awaited<ReturnType<typeof doc.embedPng>> | null> = {
    signature: input.signaturePng?.length ? await doc.embedPng(input.signaturePng) : null,
    stamp: input.stampPng?.length ? await doc.embedPng(input.stampPng) : null,
    mention: input.mentionPng?.length ? await doc.embedPng(input.mentionPng) : null,
    signature_stamp: input.combinedPng?.length ? await doc.embedPng(input.combinedPng) : null,
  };

  let placed = 0;
  for (const zone of zones) {
    const image = embedded[zone.type];
    if (!image) continue;

    const page = pages[zone.page - 1]!;
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const placement = computeImagePlacement({
      rect: zone.rect,
      pageWidth,
      pageHeight,
      rotation: normalizeRotation(page.getRotation().angle),
      imageWidth: image.width,
      imageHeight: image.height,
    });

    page.drawImage(image, {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      rotate: degrees(placement.rotateDegrees),
    });
    placed += 1;
  }

  try {
    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, placed };
  } catch (cause) {
    throw new PdfPipelineError(
      'PDF_GENERATION_FAILED',
      'Échec de l’écriture du PDF signé.',
      { cause },
    );
  }
};
