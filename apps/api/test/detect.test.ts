import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { detectInkRegions, detectInkRegionsSafely } from '../src/services/detect.js';

/**
 * Builds a sheet whose ink positions are known exactly, so the assertions can
 * be about geometry rather than "it returned something".
 *
 * signature: a wide dark scrawl in the upper-left
 * stamp:     a blue ring in the lower-right
 */
const makeSheet = async (opts: { signature?: boolean; stamp?: boolean; dim?: boolean } = {}) => {
  const { signature = true, stamp = true, dim = false } = opts;
  const width = 1600;
  const height = 1200;
  const paper = dim ? '#c9c6bd' : '#fdfcf8';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${paper}"/>
    ${
      signature
        ? `<path d="M ${width * 0.12} ${height * 0.34}
             c ${width * 0.04} -${height * 0.09}, ${width * 0.09} ${height * 0.08}, ${width * 0.13} -${height * 0.02}
             s ${width * 0.07} -${height * 0.11}, ${width * 0.11} ${height * 0.03}
             s ${width * 0.06} ${height * 0.05}, ${width * 0.12} -${height * 0.06}"
             fill="none" stroke="#12203f" stroke-width="10" stroke-linecap="round"/>
           <path d="M ${width * 0.14} ${height * 0.38} l ${width * 0.28} -${height * 0.015}"
             fill="none" stroke="#12203f" stroke-width="5" stroke-linecap="round"/>`
        : ''
    }
    ${
      stamp
        ? `<g transform="translate(${width * 0.68}, ${height * 0.66})">
             <circle r="${width * 0.11}" fill="none" stroke="#123f8f" stroke-width="11"/>
             <circle r="${width * 0.085}" fill="none" stroke="#123f8f" stroke-width="5"/>
             <text x="0" y="0" text-anchor="middle" font-family="Helvetica"
               font-size="${width * 0.028}" fill="#123f8f" font-weight="bold">SIMPLICAR</text>
           </g>`
        : ''
    }
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer());
};

const centre = (r: { x: number; y: number; width: number; height: number }) => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

// Where the marks actually are, from the SVG above.
const SIGNATURE_AREA = { x0: 0.09, x1: 0.52, y0: 0.18, y1: 0.44 };
const STAMP_AREA = { x0: 0.54, x1: 0.82, y0: 0.48, y1: 0.84 };

const within = (
  r: { x: number; y: number; width: number; height: number },
  area: { x0: number; x1: number; y0: number; y1: number },
) => {
  const c = centre(r);
  return c.x >= area.x0 && c.x <= area.x1 && c.y >= area.y0 && c.y <= area.y1;
};

describe('detectInkRegions', () => {
  it('finds the signature and the stamp, and tells them apart', async () => {
    const { signature, stamp } = await detectInkRegions(await makeSheet());

    expect(signature).not.toBeNull();
    expect(stamp).not.toBeNull();
    expect(within(signature!, SIGNATURE_AREA)).toBe(true);
    expect(within(stamp!, STAMP_AREA)).toBe(true);
  });

  it('returns boxes that are valid normalized rectangles', async () => {
    const { signature, stamp } = await detectInkRegions(await makeSheet());
    for (const rect of [signature!, stamp!]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1.0001);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1.0001);
    }
  });

  it('gives the signature a wider box than the stamp', async () => {
    const { signature, stamp } = await detectInkRegions(await makeSheet());
    const aspect = (r: { width: number; height: number }) => r.width / r.height;
    expect(aspect(signature!)).toBeGreaterThan(aspect(stamp!));
  });

  it('does not let the two boxes overlap on a well-separated sheet', async () => {
    const { signature: s, stamp: t } = await detectInkRegions(await makeSheet());
    const overlapX = Math.max(0, Math.min(s!.x + s!.width, t!.x + t!.width) - Math.max(s!.x, t!.x));
    const overlapY = Math.max(0, Math.min(s!.y + s!.height, t!.y + t!.height) - Math.max(s!.y, t!.y));
    expect(overlapX * overlapY).toBeLessThan(0.01);
  });

  it('returns only a signature when there is no stamp', async () => {
    const { signature, stamp } = await detectInkRegions(await makeSheet({ stamp: false }));
    expect(signature).not.toBeNull();
    expect(within(signature!, SIGNATURE_AREA)).toBe(true);
    expect(stamp).toBeNull();
  });

  it('still works on a dim, low-contrast photo', async () => {
    const { signature } = await detectInkRegions(await makeSheet({ dim: true }));
    expect(signature).not.toBeNull();
    expect(within(signature!, SIGNATURE_AREA)).toBe(true);
  });

  it('finds nothing on a blank sheet rather than inventing a box', async () => {
    const blank = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: '#fdfcf8' },
    })
      .jpeg()
      .toBuffer();
    const result = await detectInkRegions(new Uint8Array(blank));
    expect(result.signature).toBeNull();
    expect(result.stamp).toBeNull();
  });

  it('finds nothing in an all-dark frame — a lens cap, not a document', async () => {
    const dark = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: '#141414' },
    })
      .jpeg()
      .toBuffer();
    const result = await detectInkRegions(new Uint8Array(dark));
    expect(result.signature).toBeNull();
    expect(result.stamp).toBeNull();
  });
});

describe('detectInkRegionsSafely', () => {
  it('degrades to no suggestion instead of failing the upload', async () => {
    const result = await detectInkRegionsSafely(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result).toEqual({ signature: null, stamp: null });
  });
});
