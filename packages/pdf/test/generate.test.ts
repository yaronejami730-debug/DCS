import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { generateSignedPdf } from '../src/generate.js';
import { inspectPdf, looksLikePdf } from '../src/inspect.js';
import { PdfPipelineError } from '../src/errors.js';
import { fixtureSignaturePng, fixtureStampPng } from './helpers/png.js';

const makePdf = async (pages: Array<{ w: number; h: number; rotate?: number }>) => {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage([p.w, p.h]);
    if (p.rotate) page.setRotation(degrees(p.rotate));
  }
  return doc.save();
};

const A4 = { w: 595.28, h: 841.89 };

describe('inspectPdf', () => {
  it('reports page count, size and rotation', async () => {
    const bytes = await makePdf([
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h, rotate: 90 },
    ]);
    const info = await inspectPdf(bytes);
    expect(info.pageCount).toBe(2);
    expect(info.pages[0]!.rotation).toBe(0);
    expect(info.pages[1]!.rotation).toBe(90);
    expect(info.pages[0]!.width).toBeCloseTo(A4.w, 2);
  });

  it('rejects garbage with INVALID_PDF rather than throwing raw', async () => {
    await expect(inspectPdf(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({
      code: 'INVALID_PDF',
    });
  });
});

describe('looksLikePdf', () => {
  it('accepts a real PDF header and rejects a PNG', async () => {
    expect(looksLikePdf(await makePdf([{ w: 100, h: 100 }]))).toBe(true);
    expect(looksLikePdf(fixtureSignaturePng(4, 4))).toBe(false);
  });
});

describe('generateSignedPdf', () => {
  it('stamps a signature and a stamp and returns a readable PDF', async () => {
    const original = await makePdf([
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
    ]);
    const result = await generateSignedPdf({
      pdfBytes: original,
      zones: [
        { page: 4, type: 'signature', rect: { x: 0.7, y: 0.8, width: 0.2, height: 0.06 } },
        { page: 4, type: 'stamp', rect: { x: 0.45, y: 0.72, width: 0.15, height: 0.12 } },
      ],
      signaturePng: fixtureSignaturePng(),
      stampPng: fixtureStampPng(),
    });

    expect(result.placed).toBe(2);
    expect(looksLikePdf(result.bytes)).toBe(true);
    const info = await inspectPdf(result.bytes);
    expect(info.pageCount).toBe(4);
    // Stamping adds content, so the output is strictly larger than the input.
    expect(result.bytes.byteLength).toBeGreaterThan(original.byteLength);
  });

  it('leaves the original bytes untouched', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    const before = Buffer.from(original).toString('base64');
    await generateSignedPdf({
      pdfBytes: original,
      zones: [{ page: 1, type: 'signature', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }],
      signaturePng: fixtureSignaturePng(),
    });
    expect(Buffer.from(original).toString('base64')).toBe(before);
  });

  it('supports several signature zones on the same document', async () => {
    const original = await makePdf([
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
      { w: A4.w, h: A4.h },
    ]);
    const result = await generateSignedPdf({
      pdfBytes: original,
      zones: [
        { page: 5, type: 'signature', rect: { x: 0.7, y: 0.8, width: 0.2, height: 0.06 } },
        { page: 6, type: 'signature', rect: { x: 0.7, y: 0.8, width: 0.2, height: 0.06 } },
      ],
      signaturePng: fixtureSignaturePng(),
    });
    expect(result.placed).toBe(2);
  });

  it('handles every page rotation without throwing', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const original = await makePdf([{ w: A4.w, h: A4.h, rotate }]);
      const result = await generateSignedPdf({
        pdfBytes: original,
        zones: [
          { page: 1, type: 'signature', rect: { x: 0.6, y: 0.75, width: 0.25, height: 0.08 } },
        ],
        signaturePng: fixtureSignaturePng(),
      });
      expect(result.placed).toBe(1);
      expect((await inspectPdf(result.bytes)).pages[0]!.rotation).toBe(rotate);
    }
  });

  it('fails with TEMPLATE_ZONE_OUT_OF_RANGE when the page does not exist', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    await expect(
      generateSignedPdf({
        pdfBytes: original,
        zones: [{ page: 9, type: 'signature', rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }],
        signaturePng: fixtureSignaturePng(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_ZONE_OUT_OF_RANGE' });
  });

  it('refuses to produce a half-signed document when the stamp cutout is missing', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    const promise = generateSignedPdf({
      pdfBytes: original,
      zones: [
        { page: 1, type: 'signature', rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
        { page: 1, type: 'stamp', rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
      ],
      signaturePng: fixtureSignaturePng(),
      stampPng: null,
    });
    await expect(promise).rejects.toBeInstanceOf(PdfPipelineError);
    await expect(promise).rejects.toMatchObject({ code: 'STAMP_EXTRACTION_FAILED' });
  });

  it('rejects an empty template rather than silently returning the original', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    await expect(
      generateSignedPdf({ pdfBytes: original, zones: [], signaturePng: fixtureSignaturePng() }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });
});

describe('generateSignedPdf — the "Lu et approuvé" mention', () => {
  it('places all three marks on one page', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    const result = await generateSignedPdf({
      pdfBytes: original,
      zones: [
        { page: 1, type: 'signature', rect: { x: 0.6, y: 0.8, width: 0.3, height: 0.08 } },
        { page: 1, type: 'stamp', rect: { x: 0.1, y: 0.78, width: 0.16, height: 0.12 } },
        { page: 1, type: 'mention', rect: { x: 0.55, y: 0.7, width: 0.35, height: 0.05 } },
      ],
      signaturePng: fixtureSignaturePng(),
      stampPng: fixtureStampPng(),
      mentionPng: fixtureSignaturePng(400, 60),
    });
    expect(result.placed).toBe(3);
    expect(looksLikePdf(result.bytes)).toBe(true);
  });

  it('refuses to sign when the mention is required but missing', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    const promise = generateSignedPdf({
      pdfBytes: original,
      zones: [
        { page: 1, type: 'signature', rect: { x: 0.6, y: 0.8, width: 0.3, height: 0.08 } },
        { page: 1, type: 'mention', rect: { x: 0.55, y: 0.7, width: 0.35, height: 0.05 } },
      ],
      signaturePng: fixtureSignaturePng(),
      mentionPng: null,
    });
    await expect(promise).rejects.toMatchObject({ code: 'MENTION_EXTRACTION_FAILED' });
  });

  it('ignores an unused mention cutout', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    const result = await generateSignedPdf({
      pdfBytes: original,
      zones: [{ page: 1, type: 'signature', rect: { x: 0.6, y: 0.8, width: 0.3, height: 0.08 } }],
      signaturePng: fixtureSignaturePng(),
      mentionPng: fixtureSignaturePng(400, 60),
    });
    expect(result.placed).toBe(1);
  });

  it('supports a mention on several pages', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }, { w: A4.w, h: A4.h }]);
    const result = await generateSignedPdf({
      pdfBytes: original,
      zones: [
        { page: 1, type: 'mention', rect: { x: 0.1, y: 0.8, width: 0.35, height: 0.05 } },
        { page: 2, type: 'mention', rect: { x: 0.1, y: 0.8, width: 0.35, height: 0.05 } },
      ],
      mentionPng: fixtureSignaturePng(400, 60),
    });
    expect(result.placed).toBe(2);
  });
});

describe('generateSignedPdf — signature and stamp captured together', () => {
  it('places the combined mark like any other', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    const result = await generateSignedPdf({
      pdfBytes: original,
      zones: [
        {
          page: 1,
          type: 'signature_stamp',
          rect: { x: 0.55, y: 0.72, width: 0.35, height: 0.18 },
        },
      ],
      combinedPng: fixtureStampPng(),
    });
    expect(result.placed).toBe(1);
    expect(looksLikePdf(result.bytes)).toBe(true);
  });

  it('refuses when the combined cutout is missing', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    await expect(
      generateSignedPdf({
        pdfBytes: original,
        zones: [
          { page: 1, type: 'signature_stamp', rect: { x: 0.5, y: 0.7, width: 0.3, height: 0.15 } },
        ],
        combinedPng: null,
      }),
    ).rejects.toMatchObject({ code: 'COMBINED_EXTRACTION_FAILED' });
  });

  it('coexists with a separate mention on the same page', async () => {
    const original = await makePdf([{ w: A4.w, h: A4.h }]);
    const result = await generateSignedPdf({
      pdfBytes: original,
      zones: [
        { page: 1, type: 'signature_stamp', rect: { x: 0.55, y: 0.72, width: 0.35, height: 0.18 } },
        { page: 1, type: 'mention', rect: { x: 0.1, y: 0.8, width: 0.35, height: 0.05 } },
      ],
      combinedPng: fixtureStampPng(),
      mentionPng: fixtureSignaturePng(400, 60),
    });
    expect(result.placed).toBe(2);
  });
});
