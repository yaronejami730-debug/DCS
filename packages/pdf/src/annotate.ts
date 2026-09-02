import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { NormalizedRect, ZoneType } from '@scansign/shared';
import { PdfPipelineError } from './errors.js';
import { normalizeRotation, normalizedToPdfRect, viewportPointToPdfPoint } from './geometry.js';

export interface AnnotationZone {
  /** 1-based page number. */
  page: number;
  type: ZoneType;
  /** Normalized viewport rect, origin top-left. */
  rect: NormalizedRect;
  /** Shown on the label, e.g. "Signature 2". Defaults to the zone type. */
  label?: string;
}

export interface AnnotateTemplateInput {
  /** Bytes of the document the template describes. Never mutated. */
  pdfBytes: Uint8Array;
  zones: AnnotationZone[];
  /** Template name, printed in the footer of every annotated page. */
  templateName?: string;
}

const TONE: Record<ZoneType, { r: number; g: number; b: number; label: string }> = {
  signature: { r: 0.18, g: 0.37, b: 0.88, label: 'SIGNATURE' },
  stamp: { r: 0.06, g: 0.61, b: 0.35, label: 'TAMPON' },
  mention: { r: 0.72, g: 0.36, b: 0.05, label: 'LU ET APPROUVÉ' },
  signature_stamp: { r: 0.55, g: 0.24, b: 0.72, label: 'TAMPON + SIGNATURE' },
  date: { r: 0.75, g: 0.16, b: 0.35, label: 'DATE' },
  quote_date: { r: 0.85, g: 0.42, b: 0.1, label: 'DATE DE DEVIS' },
  invoice_date: { r: 0.85, g: 0.42, b: 0.1, label: 'DATE DE FACTURE' },
  free_text: { r: 0.25, g: 0.55, b: 0.6, label: 'TEXTE' },
  checkbox: { r: 0.35, g: 0.35, b: 0.4, label: 'CASE' },
};

/**
 * Draw a template's zones onto a copy of the document, as a proof sheet.
 *
 * This is what makes a template reviewable: the operator, or a colleague who
 * was not there when it was configured, can see exactly where the signature
 * and the stamp will land before a single document is sent out.
 *
 * It uses the same coordinate conversion as the real generator, page rotation
 * included, so what this PDF shows is genuinely what the signing step will do —
 * a preview drawn by different code would be worth much less.
 */
export const annotateTemplate = async (
  input: AnnotateTemplateInput,
): Promise<Uint8Array> => {
  const { pdfBytes, zones, templateName } = input;

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (cause) {
    throw new PdfPipelineError('INVALID_PDF', 'Impossible de lire ce fichier PDF.', { cause });
  }

  const pages = doc.getPages();
  for (const zone of zones) {
    if (!Number.isInteger(zone.page) || zone.page < 1 || zone.page > pages.length) {
      throw new PdfPipelineError(
        'TEMPLATE_ZONE_OUT_OF_RANGE',
        `Le template vise la page ${zone.page}, or le document en compte ${pages.length}.`,
      );
    }
  }

  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const annotatedPages = new Set<number>();

  for (const zone of zones) {
    const page = pages[zone.page - 1]!;
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const rotation = normalizeRotation(page.getRotation().angle);
    const tone = TONE[zone.type];
    const box = normalizedToPdfRect(zone.rect, pageWidth, pageHeight, rotation);

    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      color: rgb(tone.r, tone.g, tone.b),
      opacity: 0.12,
      borderColor: rgb(tone.r, tone.g, tone.b),
      borderWidth: 1.5,
      borderOpacity: 0.9,
      borderDashArray: [4, 3],
    });

    // The label sits just above the box as the reader sees it, so it has to be
    // anchored in viewport space and then mapped — a box cannot express it.
    // It gets an opaque pill behind it: the label lands on top of whatever the
    // document already prints there, which is very often the words "Signature
    // du client" right above the very box being marked.
    const viewport =
      rotation === 90 || rotation === 270
        ? { width: pageHeight, height: pageWidth }
        : { width: pageWidth, height: pageHeight };

    const text = zone.label ?? tone.label;
    const textSize = 7;
    const textWidth = font.widthOfTextAtSize(text, textSize);
    const pillWidth = textWidth + 8;
    const pillHeight = 11;

    const boxTop = zone.rect.y * viewport.height;
    // Near the top edge there is no room above the box, so tuck the label
    // inside it rather than letting it run off the page.
    const pillBottomInViewport =
      boxTop < pillHeight + 3 ? boxTop + pillHeight + 2 : boxTop - 2;

    const pillAnchor = viewportPointToPdfPoint(
      zone.rect.x * viewport.width,
      pillBottomInViewport,
      pageWidth,
      pageHeight,
      rotation,
    );

    page.drawRectangle({
      x: pillAnchor.x,
      y: pillAnchor.y,
      width: pillWidth,
      height: pillHeight,
      color: rgb(1, 1, 1),
      opacity: 0.92,
      borderColor: rgb(tone.r, tone.g, tone.b),
      borderWidth: 0.6,
      rotate: degrees(rotation),
    });

    // Inset the text inside the pill, in the pill's own rotated frame.
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.round(Math.cos(radians));
    const sin = Math.round(Math.sin(radians));
    const inset = { x: 4, y: 3 };

    page.drawText(text, {
      x: pillAnchor.x + inset.x * cos - inset.y * sin,
      y: pillAnchor.y + inset.x * sin + inset.y * cos,
      size: textSize,
      font,
      color: rgb(tone.r, tone.g, tone.b),
      rotate: degrees(rotation),
    });

    annotatedPages.add(zone.page);
  }

  if (templateName) {
    for (const pageNumber of annotatedPages) {
      const page = pages[pageNumber - 1]!;
      const { width: pageWidth, height: pageHeight } = page.getSize();
      const rotation = normalizeRotation(page.getRotation().angle);
      const viewport =
        rotation === 90 || rotation === 270
          ? { width: pageHeight, height: pageWidth }
          : { width: pageWidth, height: pageHeight };
      const anchor = viewportPointToPdfPoint(
        18,
        viewport.height - 14,
        pageWidth,
        pageHeight,
        rotation,
      );
      page.drawText(`Template : ${templateName} — aperçu des zones, document non signé`, {
        x: anchor.x,
        y: anchor.y,
        size: 7,
        font,
        color: rgb(0.45, 0.47, 0.52),
        rotate: degrees(rotation),
      });
    }
  }

  try {
    return await doc.save({ useObjectStreams: false });
  } catch (cause) {
    throw new PdfPipelineError('PDF_GENERATION_FAILED', 'Échec de l’écriture du PDF.', { cause });
  }
};
