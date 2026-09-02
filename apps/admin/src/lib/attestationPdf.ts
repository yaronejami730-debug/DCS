import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  ATTESTATION_SHEET_V1,
  SHEET_FIELD_MARKER,
  SHEET_PAGE,
  SHEET_PAGE_MARKER,
  sheetFieldMarkerCentres,
  sheetPageMarkerCentres,
  type SheetField,
} from '@scansign/shared';

/**
 * Build the "Attestation simplifiée d'accord" as a real PDF, in the browser.
 *
 * Two pages. The first carries the signer's identity, their authority and the
 * legal wording. The second is the capture sheet: one box per mark, each framed
 * by four printed markers, drawn from the same layout the API detects against
 * (`ATTESTATION_SHEET_V1` in @scansign/shared). The signer writes in the boxes;
 * the returned photo is read back without anyone drawing a rectangle.
 *
 * The wording is deliberate and must not drift: a handwritten signature, not an
 * electronic one; reproduction limited to the matching document with express
 * consent; never "100% legal"; and the note that it does not replace a
 * mandatory formality.
 */

export interface AttestationSigner {
  name: string;
  quality: string;
  company: string;
  siren: string;
}

export interface AttestationOptions {
  /** Free description of the operation, e.g. "Chantier 12 rue des Lilas". */
  concerned?: string;
}

const A4 = { w: SHEET_PAGE.width, h: SHEET_PAGE.height };
const MARGIN = 48;
const GREEN = rgb(0.36, 0.54, 0.45);
const GREEN_SOFT = rgb(0.92, 0.95, 0.93);
const BLUEGREY = rgb(0.35, 0.42, 0.48);
const INK = rgb(0.17, 0.23, 0.2);
const LINE = rgb(0.8, 0.83, 0.81);
const BEIGE = rgb(0.965, 0.95, 0.915);
/** Marker ink: the document's own dark green-grey, not printer black. */
const MARKER = rgb(0.13, 0.19, 0.17);
const WHITE = rgb(1, 1, 1);

/** Replace characters WinAnsi (pdf-lib's standard-font encoding) cannot draw. */
const safe = (t: string) =>
  t
    .replace(/’/g, '’') // ' typographique — WinAnsi 0x92, kept
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .replace(/[–—]/g, '-')
    .replace(/·/g, '·');

/** Greedy word wrap to a pixel width. */
const wrap = (text: string, font: PDFFont, size: number, maxWidth: number): string[] => {
  const words = safe(text).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
};

const drawParagraph = (
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  maxWidth: number,
  color = INK,
  leading = 1.45,
): number => {
  let cursor = y;
  for (const line of wrap(text, font, size, maxWidth)) {
    page.drawText(line, { x, y: cursor, size, font, color });
    cursor -= size * leading;
  }
  return cursor;
};

/** "signature_2" reads as "2"; the other boxes by what they hold. */
const markerName = (field: SheetField): string => {
  const m = /^signature_(\d+)$/.exec(field.id);
  if (m) return m[1]!;
  return field.shortLabel.toLowerCase();
};

/** Sheet coordinates are top-left; pdf-lib wants bottom-left. */
const flipY = (topY: number) => A4.h - topY;

/**
 * A fiducial marker: a solid square with softly rounded corners, in the
 * document's ink colour rather than pure black.
 *
 * The detector wants a solid, square-ish, dark blob and nothing more — it
 * thresholds on luminance well above this ink (~50 of 255) and accepts a fill
 * ratio far below a rounded square's (~97%). So the rounding and the colour
 * cost nothing in recognition and stop the sheet looking like a test chart.
 * Built from two rectangles and four discs because pdf-lib has no rounded
 * rectangle primitive.
 */
const drawMarker = (page: PDFPage, cx: number, cy: number, size: number) => {
  const r = size * 0.22;
  const left = cx - size / 2;
  const bottom = flipY(cy) - size / 2;
  page.drawRectangle({ x: left + r, y: bottom, width: size - 2 * r, height: size, color: MARKER });
  page.drawRectangle({ x: left, y: bottom + r, width: size, height: size - 2 * r, color: MARKER });
  for (const [dx, dy] of [
    [r, r],
    [size - r, r],
    [r, size - r],
    [size - r, size - r],
  ] as const) {
    page.drawCircle({ x: left + dx, y: bottom + dy, size: r, color: MARKER });
  }
};

const drawCentered = (
  page: PDFPage,
  text: string,
  centerX: number,
  baselineTopY: number,
  font: PDFFont,
  size: number,
  color = INK,
) => {
  const t = safe(text);
  const w = font.widthOfTextAtSize(t, size);
  page.drawText(t, { x: centerX - w / 2, y: flipY(baselineTopY), size, font, color });
};

/**
 * One field of the sheet: title above, white box framed by four markers, hint
 * below. The box border is faint on purpose — it must not survive extraction as
 * ink — and the markers sit outside the box so the crop never contains them.
 */
const drawField = (page: PDFPage, field: SheetField, font: PDFFont, bold: PDFFont) => {
  const { x, y, width, height } = field.rect;
  const centerX = x + width / 2;
  const markerOffset = SHEET_FIELD_MARKER.gap + SHEET_FIELD_MARKER.size / 2;

  // Title, wrapped, stacked upward so the last line sits just above the markers.
  const titleSize = 8;
  const titleLines = wrap(field.title, bold, titleSize, width + 12);
  let titleTop = y - markerOffset - 9;
  for (let i = titleLines.length - 1; i >= 0; i--) {
    drawCentered(page, titleLines[i]!, centerX, titleTop, bold, titleSize, GREEN);
    titleTop -= titleSize * 1.35;
  }

  // The writing area.
  page.drawRectangle({
    x,
    y: flipY(y) - height,
    width,
    height,
    color: WHITE,
    borderColor: LINE,
    borderWidth: 0.8,
  });

  // The four markers the detector snaps to.
  for (const c of sheetFieldMarkerCentres(field)) {
    drawMarker(page, c.x, c.y, SHEET_FIELD_MARKER.size);
  }

  // Hint below, in bold so the signer knows exactly what to write.
  const hintSize = field.type === 'signature' ? 9.5 : 9;
  const hintLines = wrap(field.hint, bold, hintSize, width + 12);
  let hintTop = y + height + markerOffset + 13;
  for (const line of hintLines) {
    drawCentered(page, line, centerX, hintTop, bold, hintSize, INK);
    hintTop += hintSize * 1.35;
  }
  // The marker's identity, tiny, for whoever reads the sheet by eye.
  drawCentered(page, `Repère ${markerName(field)}`, centerX, hintTop + 1, font, 6.5, BLUEGREY);
};

export const generateAttestationPdf = async (
  signer: AttestationSigner,
  options: AttestationOptions = {},
): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const contentW = A4.w - MARGIN * 2;
  const layout = ATTESTATION_SHEET_V1;

  // ---------------- Page 1 : identité et portée ----------------
  {
    const page = pdf.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN - 12;

    page.drawText(safe("Attestation simplifiée d'accord"), {
      x: MARGIN,
      y,
      size: 24,
      font: bold,
      color: GREEN,
    });
    y -= 34;

    y = drawParagraph(
      page,
      "Ce document nous aide à faciliter l'opération et à éviter de multiplier les formalités. Il réunit, en un seul endroit, votre accord sur les documents concernés — simplement et clairement.",
      MARGIN,
      y,
      font,
      11.5,
      contentW,
      BLUEGREY,
    );
    y -= 14;

    // Champs d'identité
    const fields: Array<[string, string]> = [
      ['Je soussigné(e) M./Mme', signer.name],
      ['Qualité du dirigeant', signer.quality],
      ['Pour la société', signer.company],
      ['SIREN ou SIRET', signer.siren],
    ];
    if (options.concerned) fields.push(['Opération concernée', options.concerned]);
    const boxH = 26 + fields.length * 33;
    page.drawRectangle({
      x: MARGIN,
      y: y - boxH,
      width: contentW,
      height: boxH,
      color: BEIGE,
      borderColor: rgb(0.905, 0.874, 0.804),
      borderWidth: 1,
    });
    let fy = y - 26;
    for (const [label, value] of fields) {
      page.drawText(safe(label), { x: MARGIN + 18, y: fy, size: 10.5, font: bold, color: BLUEGREY });
      const labelW = bold.widthOfTextAtSize(safe(label), 10.5);
      const lineX = MARGIN + 18 + labelW + 10;
      const lineEnd = MARGIN + contentW - 18;
      page.drawLine({
        start: { x: lineX, y: fy - 3 },
        end: { x: lineEnd, y: fy - 3 },
        thickness: 0.8,
        color: LINE,
        dashArray: [1.5, 2],
      });
      if (value) page.drawText(safe(value), { x: lineX, y: fy, size: 11, font, color: INK });
      fy -= 33;
    }
    y -= boxH + 20;

    // Encadré vert : habilitation
    const habil =
      "Je confirme être habilité(e) à engager la société ci-dessus, et avoir lu et accepté les documents couverts par la présente attestation.";
    const habLines = wrap(habil, font, 11, contentW - 36);
    const habH = habLines.length * 11 * 1.45 + 24;
    page.drawRectangle({ x: MARGIN, y: y - habH, width: contentW, height: habH, color: GREEN_SOFT });
    page.drawRectangle({ x: MARGIN, y: y - habH, width: 4, height: habH, color: GREEN });
    drawParagraph(page, habil, MARGIN + 18, y - 18, font, 11, contentW - 36, INK);
    y -= habH + 18;

    // Ce que couvre chaque signature
    page.drawText(safe('Documents couverts'), { x: MARGIN, y, size: 12, font: bold, color: GREEN });
    y -= 18;
    y = drawParagraph(
      page,
      "La page suivante comporte trois cases de signature. Chacune vaut accord pour le groupe de documents indiqué au-dessus d'elle, et pour lui seul :",
      MARGIN,
      y,
      font,
      11,
      contentW,
      INK,
      1.4,
    );
    y -= 4;
    const groups = layout.fields.filter((f) => f.type === 'signature');
    for (const [i, group] of groups.entries()) {
      page.drawText(safe(`${i + 1}.`), { x: MARGIN + 6, y, size: 11, font: bold, color: GREEN });
      page.drawText(safe(group.label), {
        x: MARGIN + 24,
        y,
        size: 11,
        font,
        color: INK,
      });
      y -= 17;
    }
    y -= 6;
    y = drawParagraph(
      page,
      "La mention « Lu et approuvé, bon pour accord », le nom du gérant et la date du devis, écrits une fois sur la même page, sont repris sur chacun de ces documents à l'endroit prévu.",
      MARGIN,
      y,
      font,
      11,
      contentW,
      INK,
      1.4,
    );
    y -= 10;

    // Comment ça marche — la page est lue automatiquement.
    page.drawText(safe('Comment cette page est lue'), { x: MARGIN, y, size: 12, font: bold, color: GREEN });
    y -= 18;
    drawParagraph(
      page,
      "Les petits carrés noirs autour de chaque case sont des repères : la feuille photographiée ou numérisée est reconnue automatiquement, et chaque case est reportée sur les seuls documents qu'elle désigne. Écrivez uniquement à l'intérieur des cases blanches, sans recouvrir les carrés.",
      MARGIN,
      y,
      font,
      11,
      contentW,
      INK,
      1.4,
    );

    // Note légale — bas de page
    const note =
      "À noter. Il ne s'agit pas d'une signature électronique : le dirigeant signe manuellement sur cette attestation. Chaque signature manuscrite peut ensuite être photographiée ou numérisée, puis reproduite uniquement sur les documents auxquels elle correspond, avec son accord exprès. Cette attestation ne remplace pas une formalité obligatoire propre à certains documents ou secteurs.";
    const noteY = MARGIN + 70;
    page.drawLine({
      start: { x: MARGIN, y: noteY + 14 },
      end: { x: MARGIN + contentW, y: noteY + 14 },
      thickness: 0.8,
      color: rgb(0.905, 0.874, 0.804),
    });
    drawParagraph(page, note, MARGIN, noteY, font, 9, contentW, BLUEGREY, 1.4);
  }

  // ---------------- Page 2 : la feuille de signature ----------------
  {
    const page = pdf.addPage([A4.w, A4.h]);

    // Page markers first: the detector's anchors.
    for (const c of sheetPageMarkerCentres()) {
      drawMarker(page, c.x, c.y, SHEET_PAGE_MARKER.size);
    }

    // Header
    page.drawText(safe(layout.title), {
      x: MARGIN + 14,
      y: flipY(66),
      size: 18,
      font: bold,
      color: GREEN,
    });
    const who = [signer.name, signer.quality, signer.company].filter(Boolean).join(' - ');
    if (who) {
      page.drawText(safe(who), { x: MARGIN + 14, y: flipY(82), size: 9.5, font, color: BLUEGREY });
    }
    drawParagraph(
      page,
      "Écrivez uniquement dans les cases blanches. Ne recouvrez pas les carrés noirs : ils servent au repérage automatique.",
      MARGIN + 14,
      flipY(100),
      font,
      8.5,
      contentW - 28,
      BLUEGREY,
      1.35,
    );

    for (const field of layout.fields) {
      drawField(page, field, font, bold);
    }

    // Pied
    const footTop = A4.h - MARGIN - 14;
    drawParagraph(
      page,
      "Signature manuscrite - non électronique. Chaque case n'est reproduite que sur les documents qu'elle désigne, avec l'accord exprès du signataire.",
      MARGIN + 14,
      flipY(footTop),
      font,
      8,
      contentW - 28,
      BLUEGREY,
      1.35,
    );
  }

  return pdf.save();
};
