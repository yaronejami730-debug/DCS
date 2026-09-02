import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { BuiltinInkProvider } from '../src/services/extraction/builtin.js';

/** A crop of paper with a dark stroke and, optionally, a red stamp ring. */
const crop = async (opts: { paper?: string; stroke?: boolean; stamp?: boolean } = {}) => {
  const { paper = '#f4f1e8', stroke = true, stamp = false } = opts;
  const parts = [`<rect width="100%" height="100%" fill="${paper}"/>`];
  if (stroke) {
    parts.push(
      '<path d="M 30 90 q 30 -60 60 0 t 60 0 t 60 0" stroke="#1d2a6b" stroke-width="5" fill="none"/>',
    );
  }
  if (stamp) parts.push('<circle cx="230" cy="80" r="40" stroke="#d62828" stroke-width="6" fill="none"/>');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160">${parts.join('')}</svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
};

const alphaStats = async (png: Uint8Array) => {
  const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 128) opaque += 1;
  return { opaque, pixels: info.width * info.height, sample: (x: number, y: number) => data[(y * info.width + x) * 4 + 3]! };
};

describe('BuiltinInkProvider', () => {
  const provider = new BuiltinInkProvider();

  it('keeps the stroke and drops the paper', async () => {
    const { png } = await provider.extractSignature({ image: await crop(), contentType: 'image/png' });
    const stats = await alphaStats(png);
    // Paper corner is transparent; a point on the stroke is opaque.
    expect(stats.sample(5, 5)).toBeLessThan(20);
    expect(stats.sample(60, 60)).toBeGreaterThan(200); // on the curve, t = 0.5
    // Ink is a small share of the crop — not the whole thing.
    expect(stats.opaque / stats.pixels).toBeGreaterThan(0.005);
    expect(stats.opaque / stats.pixels).toBeLessThan(0.15);
  });

  it('keeps a coloured stamp that is barely darker than the paper', async () => {
    const { png } = await provider.extractStamp({
      image: await crop({ stroke: false, stamp: true }),
      contentType: 'image/png',
    });
    const stats = await alphaStats(png);
    expect(stats.sample(230 + 40, 80)).toBeGreaterThan(200);
    expect(stats.sample(230, 80)).toBeLessThan(20); // inside the ring: paper
  });

  it('refuses a blank crop with the no-ink verdict (422), never a service failure', async () => {
    await expect(
      provider.extractSignature({ image: await crop({ stroke: false }), contentType: 'image/png' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
