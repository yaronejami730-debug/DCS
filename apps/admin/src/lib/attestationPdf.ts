import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * Build the "Attestation simplifiée d'accord" as a real PDF, in the browser.
 *
 * A generated file, not a print dialog: the operator fills a normal console
 * form and gets a PDF to save or send. The layout mirrors the standalone tool —
 * an intro page carrying the signer's identity and authority, then one A4 page
 * per document with an info block, a large signature-and-stamp box, and the
 * "Lu et approuvé" mention only where enabled.
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

export interface AttestationDoc {
  type: string;
  concerned: string;
  showApproval: boolean;
  /** What the signature box asks for. At least one must be true. */
  wantSignature: boolean;
  wantStamp: boolean;
  /** Signature and stamp in one shared space, rather than two split zones. */
  combined: boolean;
}

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 48;
const GREEN = rgb(0.36, 0.54, 0.45);
const GREEN_SOFT = rgb(0.92, 0.95, 0.93);
const BLUEGREY = rgb(0.35, 0.42, 0.48);
const INK = rgb(0.17, 0.23, 0.2);
const LINE = rgb(0.8, 0.83, 0.81);
const BEIGE = rgb(0.965, 0.95, 0.915);

/** Replace characters WinAnsi (pdf-lib's standard-font encoding) cannot draw. */
const safe = (t: string) =>
  t
    .replace(/’/g, '’') // ' typographique — WinAnsi 0x92, kept
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .replace(/[–—]/g, '-');

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

export const generateAttestationPdf = async (
  signer: AttestationSigner,
  docs: AttestationDoc[],
): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const contentW = A4.w - MARGIN * 2;

  // ---------------- Intro ----------------
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

    // Champs
    const boxH = 150;
    page.drawRectangle({
      x: MARGIN,
      y: y - boxH,
      width: contentW,
      height: boxH,
      color: BEIGE,
      borderColor: rgb(0.905, 0.874, 0.804),
      borderWidth: 1,
    });
    const fields: Array<[string, string]> = [
      ['Je soussigné(e) M./Mme', signer.name],
      ['Qualité du dirigeant', signer.quality],
      ['Pour la société', signer.company],
      ['SIREN ou SIRET', signer.siren],
    ];
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
      if (value)
        page.drawText(safe(value), { x: lineX, y: fy, size: 11, font, color: INK });
      fy -= 33;
    }
    y -= boxH + 20;

    // Encadré vert : habilitation
    const habil =
      "Je confirme être habilité(e) à engager la société ci-dessus, et avoir lu et accepté les documents listés dans la présente attestation.";
    const habLines = wrap(habil, font, 11, contentW - 36);
    const habH = habLines.length * 11 * 1.45 + 24;
    page.drawRectangle({ x: MARGIN, y: y - habH, width: contentW, height: habH, color: GREEN_SOFT });
    page.drawRectangle({ x: MARGIN, y: y - habH, width: 4, height: habH, color: GREEN });
    drawParagraph(page, habil, MARGIN + 18, y - 18, font, 11, contentW - 36, INK);
    y -= habH + 16;

    // À quoi sert ce document — comble le blanc sous l'habilitation.
    page.drawText(safe('À quoi sert ce document'), {
      x: MARGIN,
      y,
      size: 12,
      font: bold,
      color: GREEN,
    });
    y -= 18;
    y = drawParagraph(
      page,
      "Cette attestation réunit, en une seule fois, votre accord sur les documents concernés. Elle nous évite de vous solliciter à répétition : vous signez à la main, une fois, et chaque signature n'est ensuite reprise que sur le document auquel elle correspond. Vous gardez la maîtrise de ce que vous acceptez, document par document, sur les pages qui suivent.",
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
      "À noter. Il ne s'agit pas d'une signature électronique : le dirigeant signe manuellement sur cette attestation. Chaque signature manuscrite peut ensuite être photographiée ou numérisée, puis reproduite uniquement sur le document auquel elle correspond, avec son accord exprès. Cette attestation ne remplace pas une formalité obligatoire propre à certains documents ou secteurs.";
    const noteY = MARGIN + 70;
    page.drawLine({
      start: { x: MARGIN, y: noteY + 14 },
      end: { x: MARGIN + contentW, y: noteY + 14 },
      thickness: 0.8,
      color: rgb(0.905, 0.874, 0.804),
    });
    drawParagraph(page, note, MARGIN, noteY, font, 9, contentW, BLUEGREY, 1.4);
  }

  // ---------------- Une page par document ----------------
  docs.forEach((doc, i) => {
    const page = pdf.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN - 10;

    page.drawText(safe(`Document ${i + 1} - ${doc.type}`), {
      x: MARGIN,
      y,
      size: 16,
      font: bold,
      color: GREEN,
    });
    y -= 10;
    page.drawLine({
      start: { x: MARGIN, y: y - 3 },
      end: { x: MARGIN + contentW, y: y - 3 },
      thickness: 1.5,
      color: GREEN_SOFT,
    });
    y -= 18;

    const concerned = doc.concerned || '__________________________________';
    page.drawText(safe(`Document concerné : ${concerned}`), {
      x: MARGIN,
      y,
      size: 11,
      font: bold,
      color: BLUEGREY,
    });
    y -= 16;

    // Deux zones côte à côte
    const gap = 18;
    const colW = (contentW - gap) / 2;
    const zoneH = 340;
    const zoneTop = y;

    // Infos (gauche)
    page.drawRectangle({
      x: MARGIN,
      y: zoneTop - zoneH,
      width: colW,
      height: zoneH,
      color: rgb(0.988, 0.984, 0.969),
      borderColor: LINE,
      borderWidth: 1.5,
    });
    page.drawText(safe('INFORMATIONS DU DOCUMENT CONCERNÉ'), {
      x: MARGIN + 14,
      y: zoneTop - 22,
      size: 8.5,
      font: bold,
      color: BLUEGREY,
    });
    const infoLines = Math.floor((zoneH - 44) / 24);
    for (let l = 0; l < infoLines; l++) {
      const ly = zoneTop - 44 - l * 24;
      page.drawLine({
        start: { x: MARGIN + 14, y: ly },
        end: { x: MARGIN + colW - 14, y: ly },
        thickness: 0.6,
        color: LINE,
        dashArray: [1.5, 2],
      });
    }

    // Signature / cachet (droite) — le titre et le découpage suivent ce qui est demandé.
    const sx = MARGIN + colW + gap;
    const wantSig = doc.wantSignature;
    const wantStamp = doc.wantStamp;
    const combined = doc.combined && wantSig && wantStamp;
    // 'both' drives the split-in-two layout; a combined mark stays one space.
    const both = wantSig && wantStamp && !combined;
    const sigTitle = combined
      ? 'Signature manuscrite et cachet de la société (au même endroit)'
      : wantSig && wantStamp
        ? 'Signature manuscrite du dirigeant et cachet de la société'
        : wantStamp
          ? 'Cachet de la société'
          : 'Signature manuscrite du dirigeant';

    page.drawRectangle({
      x: sx,
      y: zoneTop - zoneH,
      width: colW,
      height: zoneH,
      borderColor: GREEN,
      borderWidth: 2,
    });
    // bandeau titre
    page.drawRectangle({ x: sx, y: zoneTop - 28, width: colW, height: 28, color: GREEN });
    const sigLines = wrap(sigTitle, bold, 8.5, colW - 16);
    let sty = zoneTop - 11;
    for (const line of sigLines) {
      const lw = bold.widthOfTextAtSize(safe(line), 8.5);
      page.drawText(safe(line), {
        x: sx + (colW - lw) / 2,
        y: sty,
        size: 8.5,
        font: bold,
        color: rgb(1, 1, 1),
      });
      sty -= 11;
    }

    // When both are asked for, split the box into two labelled halves so the
    // signer knows which goes where. When only one, the single title above is
    // enough and the whole box is its space.
    if (both) {
      const bandBottom = zoneTop - 28; // under the title band
      const midY = (bandBottom + (zoneTop - zoneH)) / 2;
      page.drawLine({
        start: { x: sx + 10, y: midY },
        end: { x: sx + colW - 10, y: midY },
        thickness: 0.6,
        color: LINE,
        dashArray: [3, 3],
      });
      page.drawText(safe('Signature'), {
        x: sx + 12,
        y: bandBottom - 14,
        size: 8,
        font,
        color: BLUEGREY,
      });
      page.drawText(safe('Cachet'), {
        x: sx + 12,
        y: midY - 14,
        size: 8,
        font,
        color: BLUEGREY,
      });
    }
    // mention conditionnelle
    if (doc.showApproval) {
      const m = safe('Mention : « Lu et approuvé »');
      const mw = italic.widthOfTextAtSize(m, 10);
      page.drawLine({
        start: { x: sx + 12, y: zoneTop - zoneH + 30 },
        end: { x: sx + colW - 12, y: zoneTop - zoneH + 30 },
        thickness: 0.6,
        color: LINE,
        dashArray: [2, 2],
      });
      page.drawText(m, {
        x: sx + (colW - mw) / 2,
        y: zoneTop - zoneH + 12,
        size: 10,
        font: italic,
        color: BLUEGREY,
      });
    }

    y = zoneTop - zoneH - 18;

    // Autorisation cochée à la main par le dirigeant, nommant le document.
    const docName = doc.concerned || doc.type;
    const authText =
      "J'autorise que la signature portée sur cette page soit reproduite uniquement sur le document concerné : " +
      docName +
      '.';
    const boxSize = 13;
    const textX = MARGIN + 40 + boxSize;
    const authLines = wrap(authText, font, 11, contentW - 80 - boxSize);
    const cH = Math.max(authLines.length * 11 * 1.45 + 22, 44);
    // encadré centré
    const cardW = contentW;
    page.drawRectangle({
      x: MARGIN,
      y: y - cH,
      width: cardW,
      height: cH,
      color: rgb(0.933, 0.945, 0.956),
    });
    // checkbox vide, à cocher à la main
    page.drawRectangle({
      x: MARGIN + 20,
      y: y - 18 - 2,
      width: boxSize,
      height: boxSize,
      borderColor: GREEN,
      borderWidth: 1.5,
      color: rgb(1, 1, 1),
    });
    let ay = y - 16;
    for (const line of authLines) {
      page.drawText(safe(line), { x: textX, y: ay, size: 11, font, color: INK });
      ay -= 11 * 1.45;
    }

    // Pied
    drawParagraph(
      page,
      'Signature manuscrite - non électronique. Reproduction limitée au seul document concerné, avec accord exprès du signataire.',
      MARGIN,
      MARGIN + 12,
      font,
      8.5,
      contentW,
      BLUEGREY,
    );
  });

  return pdf.save();
};
