/**
 * Fixture generators for local testing.
 *
 * `makeContractPdf` produces a believable 4-page contract with visible
 * signature and stamp boxes on the last page, so the template editor has
 * something real to point at.
 *
 * `makeSignatureSheetPhoto` fakes what the phone camera sees: a white sheet
 * with an inked signature and a round stamp, plus paper grain and a slight
 * warm cast, so the extraction engine is exercised rather than handed a
 * perfectly clean synthetic image.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';

export const makeContractPdf = async ({
  title = 'Contrat de vente SimpliCar',
  pages = 4,
  rotate = 0,
} = {}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    if (rotate) page.setRotation({ type: 'degrees', angle: rotate });
    page.drawText(title, { x: 60, y: 780, size: 18, font: bold });
    page.drawText(`Page ${i} / ${pages}`, { x: 60, y: 758, size: 10, font, color: rgb(0.45, 0.45, 0.45) });

    for (let line = 0; line < 22; line++) {
      page.drawRectangle({
        x: 60,
        y: 700 - line * 22,
        width: 380 + ((line * 37) % 95),
        height: 6,
        color: rgb(0.87, 0.87, 0.89),
      });
    }

    if (i === pages) {
      page.drawText('Signature du client', { x: 380, y: 200, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
      page.drawRectangle({ x: 380, y: 120, width: 160, height: 70, borderColor: rgb(0.75, 0.75, 0.78), borderWidth: 1 });
      page.drawText('Cachet de la société', { x: 70, y: 200, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
      page.drawRectangle({ x: 70, y: 95, width: 110, height: 95, borderColor: rgb(0.75, 0.75, 0.78), borderWidth: 1 });
    }
  }
  return doc.save();
};

/** SVG is the quickest way to draw convincing ink strokes without a canvas dep. */
const sheetSvg = (width, height) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#fdfcf8"/>
  <path d="M ${width * 0.12} ${height * 0.34}
           c ${width * 0.04} -${height * 0.09}, ${width * 0.09} ${height * 0.08}, ${width * 0.13} -${height * 0.02}
           s ${width * 0.07} -${height * 0.11}, ${width * 0.11} ${height * 0.03}
           s ${width * 0.06} ${height * 0.05}, ${width * 0.12} -${height * 0.06}"
        fill="none" stroke="#12203f" stroke-width="${Math.max(3, width * 0.006)}"
        stroke-linecap="round"/>
  <path d="M ${width * 0.14} ${height * 0.38} l ${width * 0.28} -${height * 0.015}"
        fill="none" stroke="#12203f" stroke-width="${Math.max(2, width * 0.003)}" stroke-linecap="round"/>
  <g transform="translate(${width * 0.68}, ${height * 0.66})">
    <circle r="${width * 0.11}" fill="none" stroke="#123f8f" stroke-width="${Math.max(3, width * 0.007)}"/>
    <circle r="${width * 0.085}" fill="none" stroke="#123f8f" stroke-width="${Math.max(2, width * 0.003)}"/>
    <text x="0" y="-${width * 0.012}" text-anchor="middle" font-family="Helvetica, Arial"
          font-size="${width * 0.028}" fill="#123f8f" font-weight="bold">SIMPLICAR</text>
    <text x="0" y="${width * 0.028}" text-anchor="middle" font-family="Helvetica, Arial"
          font-size="${width * 0.018}" fill="#123f8f">SAS - PARIS</text>
  </g>
</svg>`;

export const makeSignatureSheetPhoto = async ({ width = 1600, height = 1200 } = {}) => {
  const base = await sharp(Buffer.from(sheetSvg(width, height))).png().toBuffer();

  // Paper grain: low-amplitude noise so the background is not a flat value.
  const grain = await sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 6 } },
  })
    .png()
    .toBuffer();

  return sharp(base)
    .composite([{ input: grain, blend: 'overlay' }])
    .modulate({ brightness: 1.02, saturation: 0.96 })
    .jpeg({ quality: 90 })
    .toBuffer();
};

/**
 * Where the signature and the stamp sit in the generated photo, as normalized
 * 0..1 rectangles — i.e. exactly what the phone would send after the user
 * dragged a box around each one.
 */
export const SHEET_REGIONS = {
  signature: { x: 0.06, y: 0.16, width: 0.46, height: 0.3 },
  stamp: { x: 0.54, y: 0.5, width: 0.29, height: 0.36 },
};
