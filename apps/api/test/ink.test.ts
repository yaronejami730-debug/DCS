import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { inkStats, restoreInk, smoothEdges } from '../src/services/ink.js';

/**
 * A cutout as background removal actually leaves one: transparent paper,
 * strokes at whatever grey the photo's lighting gave them.
 */
const makeCutout = async (inkColour: string, width = 400, height = 120) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <path d="M 20 80 C 90 20, 150 100, 220 40 S 320 70, 380 50"
      fill="none" stroke="${inkColour}" stroke-width="7" stroke-linecap="round"/>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
};

const transparentShare = async (png: Uint8Array) => {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let clear = 0;
  let total = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    total += 1;
    if (data[i]! < 24) clear += 1;
  }
  return clear / total;
};

describe('restoreInk', () => {
  it('darkens pale ink — the washed-out look', async () => {
    const pale = await makeCutout('#8a8a92');
    const before = await inkStats(pale);
    const after = await inkStats(await restoreInk(pale, { smooth: false }));

    expect(before.luminance).toBeGreaterThan(100);
    expect(after.luminance).toBeLessThan(before.luminance * 0.75);
  });

  it('leaves ink that is already dark alone', async () => {
    const dark = await makeCutout('#0d0d12');
    const before = await inkStats(dark);
    const after = await inkStats(await restoreInk(dark, { smooth: false }));
    // Within a few points: a black pen must not be crushed further.
    expect(Math.abs(after.luminance - before.luminance)).toBeLessThan(12);
  });

  it('keeps the background transparent', async () => {
    const pale = await makeCutout('#8a8a92');
    const beforeShare = await transparentShare(pale);
    const afterShare = await transparentShare(await restoreInk(pale, { smooth: false }));
    expect(beforeShare).toBeGreaterThan(0.7);
    // The whole point: darkening ink must never paint the paper back in.
    expect(afterShare).toBeGreaterThan(beforeShare - 0.02);
  });

  it('preserves hue — a blue pen stays blue', async () => {
    const blue = await makeCutout('#5a7fd0');
    const restored = await restoreInk(blue, { smooth: false });
    const { data, info } = await sharp(Buffer.from(restored))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3]! < 200) continue;
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
      n += 1;
    }
    expect(n).toBeGreaterThan(0);
    // Blue must still dominate red after darkening.
    expect(b / n).toBeGreaterThan((r / n) * 1.3);
  });

  it('firms up partially transparent stroke edges', async () => {
    const pale = await makeCutout('#8a8a92');
    const before = await inkStats(pale);
    const after = await inkStats(await restoreInk(pale, { smooth: false }));
    expect(after.opacity).toBeGreaterThanOrEqual(before.opacity);
  });

  it('returns the input rather than failing on an unreadable image', async () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    expect(Buffer.from(await restoreInk(junk)).equals(Buffer.from(junk))).toBe(true);
  });

  it('does nothing to a fully transparent image', async () => {
    const blank = new Uint8Array(
      await sharp({
        create: { width: 60, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    );
    const restored = await restoreInk(blank);
    expect((await inkStats(restored)).pixels).toBe(0);
  });
});

describe('smoothEdges', () => {
  /** How much of the ink sits at partial coverage — the anti-aliased rim. */
  const edgeShare = async (png: Uint8Array) => {
    const { data, info } = await sharp(Buffer.from(png))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let solid = 0;
    let partial = 0;
    for (let i = 3; i < data.length; i += info.channels) {
      const a = data[i]!;
      if (a >= 224) solid += 1;
      else if (a >= 32) partial += 1;
    }
    return { share: partial / (solid + partial || 1), content: solid + partial };
  };

  it('turns a hard mask into one with a real edge gradient', async () => {
    // A binary mask, exactly what the engine's threshold produces.
    const hard = new Uint8Array(
      await sharp({
        create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([
          {
            input: await sharp({
              create: { width: 160, height: 12, channels: 4, background: { r: 20, g: 20, b: 26, alpha: 1 } },
            })
              .png()
              .toBuffer(),
            left: 70,
            top: 44,
          },
        ])
        .png()
        .toBuffer(),
    );

    const before = await edgeShare(hard);
    const after = await edgeShare(await smoothEdges(hard));
    expect(before.share).toBeLessThan(0.1);
    expect(after.share).toBeGreaterThan(before.share * 2);
  });

  it('keeps the ink — the channel-count bug destroyed it', async () => {
    // sharp returns three channels for a one-channel raw blur input. Reading
    // that with a stride of 1 once cut a signature to 0.1% of its pixels.
    const signature = await makeCutout('#2a2a33');
    const before = await edgeShare(signature);
    const after = await edgeShare(await smoothEdges(signature));
    // Smoothing spreads coverage, so content grows; it must never collapse.
    expect(after.content).toBeGreaterThan(before.content);
  });

  it('upscales so the PDF has pixels to render from', async () => {
    const small = await makeCutout('#2a2a33', 300, 90);
    const out = await smoothEdges(small);
    const meta = await sharp(Buffer.from(out)).metadata();
    expect(meta.width!).toBeGreaterThan(300);
    // Aspect ratio must survive: passing width alone to resize once stretched it.
    expect(meta.width! / meta.height!).toBeCloseTo(300 / 90, 1);
  });

  it('preserves the pen colour through the resample', async () => {
    const blue = await makeCutout('#4a6fd0');
    const out = await smoothEdges(blue);
    const { data, info } = await sharp(Buffer.from(out))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let r = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3]! < 200) continue;
      r += data[i]!;
      b += data[i + 2]!;
      n += 1;
    }
    expect(n).toBeGreaterThan(0);
    // Resampling against black transparent pixels once turned this black.
    expect(b / n).toBeGreaterThan((r / n) * 1.5);
  });

  it('returns the input rather than failing on junk', async () => {
    const junk = new Uint8Array([9, 9, 9]);
    expect(Buffer.from(await smoothEdges(junk)).equals(Buffer.from(junk))).toBe(true);
  });
});
