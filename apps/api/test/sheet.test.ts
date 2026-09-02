import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  ATTESTATION_SHEET_V1,
  SHEET_FIELD_MARKER,
  SHEET_PAGE,
  SHEET_PAGE_MARKER,
  sheetFieldMarkerCentres,
  sheetPageMarkerCentres,
} from '@scansign/shared';
import { detectSheet } from '../src/services/sheet.js';

/**
 * Render the sheet the way the console prints it — from the same layout — into
 * a "photo": the page at `scale` px/pt, sitting at an offset on a darker desk,
 * with a scribble in one box standing in for a signature.
 */
const renderSheet = async (opts: { scale: number; pad: number; rotate?: 0 | 180 }) => {
  const { scale, pad } = opts;
  const pw = Math.round(SHEET_PAGE.width * scale);
  const ph = Math.round(SHEET_PAGE.height * scale);
  const squares: string[] = [];
  const square = (cx: number, cy: number, size: number) =>
    `<rect x="${(cx - size / 2) * scale}" y="${(cy - size / 2) * scale}" width="${size * scale}" height="${size * scale}" fill="#000"/>`;
  for (const c of sheetPageMarkerCentres()) squares.push(square(c.x, c.y, SHEET_PAGE_MARKER.size));
  for (const f of ATTESTATION_SHEET_V1.fields) {
    for (const c of sheetFieldMarkerCentres(f)) squares.push(square(c.x, c.y, SHEET_FIELD_MARKER.size));
    // faint printed border, like the PDF
    squares.push(
      `<rect x="${f.rect.x * scale}" y="${f.rect.y * scale}" width="${f.rect.width * scale}" height="${f.rect.height * scale}" fill="none" stroke="#ccd" stroke-width="1"/>`,
    );
  }
  // a signature-like scribble inside the first box
  const s1 = ATTESTATION_SHEET_V1.fields[0]!.rect;
  const sx = (s1.x + 15) * scale;
  const sy = (s1.y + s1.height / 2) * scale;
  squares.push(
    `<path d="M ${sx} ${sy} q 20 -40 40 0 t 40 0 t 40 0" stroke="#1a2a8a" stroke-width="${2 * scale}" fill="none"/>`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"><rect width="100%" height="100%" fill="#fff"/>${squares.join('')}</svg>`;
  let page = sharp(Buffer.from(svg)).png();
  if (opts.rotate === 180) page = page.rotate(180);
  const pageBuf = await page.toBuffer();

  const photo = await sharp({
    create: { width: pw + pad * 2, height: ph + pad * 2, channels: 3, background: '#8a8378' },
  })
    .composite([{ input: pageBuf, left: pad, top: pad }])
    .jpeg({ quality: 90 })
    .toBuffer();
  return { photo: new Uint8Array(photo), width: pw + pad * 2, height: ph + pad * 2, pw, ph };
};

describe('detectSheet', () => {
  it('finds every field of the printed sheet in a straight photo', async () => {
    const { photo, width, height, pw, ph } = await renderSheet({ scale: 2, pad: 90 });
    const pad = 90;
    const result = await detectSheet(photo);
    expect(result).not.toBeNull();
    expect(result!.layoutId).toBe('attestation-v1');
    expect(result!.rotation).toBe(0);
    expect(result!.fields).toHaveLength(ATTESTATION_SHEET_V1.fields.length);

    for (const field of ATTESTATION_SHEET_V1.fields) {
      const found = result!.fields.find((f) => f.id === field.id)!;
      expect(found.type).toBe(field.type);
      expect(found.markersFound).toBe(4);
      // Expected: the writing area, in photo-normalized coordinates.
      const ex = (pad + field.rect.x * 2) / width;
      const ey = (pad + field.rect.y * 2) / height;
      const ew = (field.rect.width * 2) / width;
      const eh = (field.rect.height * 2) / height;
      // Within a marker's width, and never larger than the printed box.
      const tol = (SHEET_FIELD_MARKER.size * 2) / Math.min(pw, ph);
      expect(Math.abs(found.rect.x - ex)).toBeLessThan(tol);
      expect(Math.abs(found.rect.y - ey)).toBeLessThan(tol);
      expect(found.rect.width).toBeLessThanOrEqual(ew + 1e-6);
      expect(found.rect.height).toBeLessThanOrEqual(eh + 1e-6);
      expect(found.rect.width).toBeGreaterThan(ew * 0.9);
      expect(found.rect.height).toBeGreaterThan(eh * 0.85);
    }
  });

  it('recognises a sheet photographed upside down and still lands each box', async () => {
    const pad = 60;
    const { photo, width, height } = await renderSheet({ scale: 2, pad, rotate: 180 });
    const result = await detectSheet(photo);
    expect(result).not.toBeNull();
    expect(result!.rotation).toBe(180);

    const field = ATTESTATION_SHEET_V1.fields.find((f) => f.id === 'quote_date')!;
    const found = result!.fields.find((f) => f.id === 'quote_date')!;
    // Upside down, the box's centre is mirrored through the page centre.
    const cxSheet = field.rect.x + field.rect.width / 2;
    const cySheet = field.rect.y + field.rect.height / 2;
    const ex = (pad + (SHEET_PAGE.width - cxSheet) * 2) / width;
    const ey = (pad + (SHEET_PAGE.height - cySheet) * 2) / height;
    expect(Math.abs(found.rect.x + found.rect.width / 2 - ex)).toBeLessThan(0.01);
    expect(Math.abs(found.rect.y + found.rect.height / 2 - ey)).toBeLessThan(0.01);
  });

  it('returns null for a page without markers', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="100%" height="100%" fill="#fff"/><path d="M 100 500 q 40 -80 80 0 t 80 0 t 80 0" stroke="#000" stroke-width="4" fill="none"/></svg>`;
    const photo = new Uint8Array(await sharp(Buffer.from(svg)).jpeg().toBuffer());
    expect(await detectSheet(photo)).toBeNull();
  });
});
