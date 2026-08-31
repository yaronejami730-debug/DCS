import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { annotateTemplate } from '../src/annotate.js';
import { inspectPdf, looksLikePdf } from '../src/inspect.js';
import { viewportPointToPdfPoint } from '../src/geometry.js';

const A4 = { w: 595.28, h: 841.89 };

const makePdf = async (pages: Array<{ rotate?: number }>) => {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage([A4.w, A4.h]);
    if (p.rotate) page.setRotation(degrees(p.rotate));
  }
  return doc.save();
};

const ZONES = [
  { page: 4, type: 'signature' as const, rect: { x: 0.63, y: 0.79, width: 0.28, height: 0.09 } },
  { page: 4, type: 'stamp' as const, rect: { x: 0.11, y: 0.77, width: 0.19, height: 0.12 } },
];

describe('viewportPointToPdfPoint', () => {
  it('maps the viewport origin to the right page corner for every rotation', () => {
    const W = 600;
    const H = 800;
    // viewport (0,0) is the top-left the reader sees.
    expect(viewportPointToPdfPoint(0, 0, W, H, 0)).toEqual({ x: 0, y: H });
    expect(viewportPointToPdfPoint(0, 0, W, H, 90)).toEqual({ x: 0, y: 0 });
    expect(viewportPointToPdfPoint(0, 0, W, H, 180)).toEqual({ x: W, y: 0 });
    expect(viewportPointToPdfPoint(0, 0, W, H, 270)).toEqual({ x: W, y: H });
  });

  it('agrees with normalizedToPdfRect on the corner a box starts from', async () => {
    const { normalizedToPdfRect } = await import('../src/geometry.js');
    const W = 600;
    const H = 800;
    const rect = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 };

    for (const rotation of [0, 90, 180, 270] as const) {
      const vp = rotation === 90 || rotation === 270 ? { w: H, h: W } : { w: W, h: H };
      const corners = [
        viewportPointToPdfPoint(rect.x * vp.w, rect.y * vp.h, W, H, rotation),
        viewportPointToPdfPoint(
          (rect.x + rect.width) * vp.w,
          (rect.y + rect.height) * vp.h,
          W,
          H,
          rotation,
        ),
      ];
      const box = normalizedToPdfRect(rect, W, H, rotation);
      const minX = Math.min(corners[0]!.x, corners[1]!.x);
      const minY = Math.min(corners[0]!.y, corners[1]!.y);
      expect(minX).toBeCloseTo(box.x, 4);
      expect(minY).toBeCloseTo(box.y, 4);
    }
  });
});

describe('annotateTemplate', () => {
  it('returns a readable PDF with the same pages', async () => {
    const original = await makePdf([{}, {}, {}, {}]);
    const out = await annotateTemplate({
      pdfBytes: original,
      zones: ZONES,
      templateName: 'Contrat de vente',
    });

    expect(looksLikePdf(out)).toBe(true);
    const info = await inspectPdf(out);
    expect(info.pageCount).toBe(4);
    expect(out.byteLength).toBeGreaterThan(original.byteLength);
  });

  it('leaves the original bytes untouched', async () => {
    const original = await makePdf([{}]);
    const before = Buffer.from(original).toString('base64');
    await annotateTemplate({
      pdfBytes: original,
      zones: [{ page: 1, type: 'signature', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }],
    });
    expect(Buffer.from(original).toString('base64')).toBe(before);
  });

  it('handles every page rotation', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const original = await makePdf([{ rotate }]);
      const out = await annotateTemplate({
        pdfBytes: original,
        zones: [{ page: 1, type: 'stamp', rect: { x: 0.6, y: 0.7, width: 0.2, height: 0.1 } }],
        templateName: 'Rotated',
      });
      expect((await inspectPdf(out)).pages[0]!.rotation).toBe(rotate);
    }
  });

  it('rejects a zone pointing past the last page', async () => {
    const original = await makePdf([{}]);
    await expect(
      annotateTemplate({
        pdfBytes: original,
        zones: [{ page: 7, type: 'signature', rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }],
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_ZONE_OUT_OF_RANGE' });
  });

  it('accepts a template with no zones — an empty proof sheet is still valid', async () => {
    const original = await makePdf([{}]);
    const out = await annotateTemplate({ pdfBytes: original, zones: [] });
    expect(looksLikePdf(out)).toBe(true);
  });

  it('rejects a file that is not a PDF', async () => {
    await expect(
      annotateTemplate({ pdfBytes: new Uint8Array([1, 2, 3]), zones: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_PDF' });
  });
});
