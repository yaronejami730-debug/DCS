import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  applyVariant,
  fallbackVariantIndex,
  generateVariants,
  variantAt,
  variantParamsFor,
} from '../src/services/variants.js';

/** A transparent PNG with an opaque diagonal stroke — stands in for ink. */
const makeSignature = async (width = 300, height = 100) => {
  const s = (v: number) => (v * width) / 300;
  const t = (v: number) => (v * height) / 100;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <path d="M ${s(20)} ${t(70)} C ${s(80)} ${t(10)}, ${s(140)} ${t(90)}, ${s(200)} ${t(30)}
             S ${s(270)} ${t(60)}, ${s(285)} ${t(45)}"
      fill="none" stroke="#12203f" stroke-width="${Math.max(4, s(6))}" stroke-linecap="round"/>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
};

const opaquePixels = async (png: Uint8Array) => {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i]! > 16) count += 1;
  return count;
};

describe('variantParamsFor', () => {
  it('is deterministic — the same seed always gives the same variation', () => {
    const a = variantParamsFor('session:doc:0');
    const b = variantParamsFor('session:doc:0');
    expect(a).toEqual(b);
  });

  it('gives different placements a different variation', () => {
    const first = variantParamsFor('session:doc:0');
    const second = variantParamsFor('session:doc:1');
    const otherDoc = variantParamsFor('session:other:0');
    expect(first).not.toEqual(second);
    expect(first).not.toEqual(otherDoc);
  });

  it('stays within the range a steady hand varies by', () => {
    // 200 seeds: none may drift far enough to stop looking like the same hand.
    for (let i = 0; i < 200; i++) {
      const p = variantParamsFor(`seed-${i}`);
      expect(Math.abs(p.rotate)).toBeLessThanOrEqual(1.5);
      expect(p.scale).toBeGreaterThanOrEqual(0.965);
      expect(p.scale).toBeLessThanOrEqual(1.035);
      expect(Math.abs(p.shear)).toBeLessThanOrEqual(0.022);
      // The drift must stay slow AND shallow. An earlier version ran to four
      // cycles at a 5.5% amplitude, which made the signature visibly ripple —
      // no hand does that. A hand drifts.
      for (const wave of p.waves) {
        expect(wave.freqX).toBeLessThanOrEqual(1.5);
        expect(wave.freqY).toBeLessThanOrEqual(1.5);
        expect(Math.abs(wave.ampX)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(wave.ampY)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('applyVariant', () => {
  it('keeps transparency, so it never paints a box on the contract', async () => {
    const signature = await makeSignature();
    const varied = await applyVariant(signature, variantParamsFor('x'));
    const meta = await sharp(Buffer.from(varied)).metadata();
    expect(meta.hasAlpha).toBe(true);

    // The corners must still be see-through after rotation.
    const { data, info } = await sharp(Buffer.from(varied))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const topLeftAlpha = data[3]!;
    expect(topLeftAlpha).toBeLessThan(32);
    expect(info.channels).toBe(4);
  });

  it('produces a different image from the original', async () => {
    const signature = await makeSignature();
    const varied = await applyVariant(signature, variantParamsFor('seed'));
    expect(Buffer.from(varied).equals(Buffer.from(signature))).toBe(false);
  });

  it('keeps the ink recognisably the same size', async () => {
    const signature = await makeSignature();
    const before = await opaquePixels(signature);
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const varied = await applyVariant(signature, variantParamsFor(seed));
      const after = await opaquePixels(varied);
      // Within a quarter of the original mass: still the same signature.
      expect(after).toBeGreaterThan(before * 0.75);
      expect(after).toBeLessThan(before * 1.35);
    }
  });

  it('returns the original rather than failing on an unreadable image', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await applyVariant(junk, variantParamsFor('x'));
    expect(Buffer.from(result).equals(Buffer.from(junk))).toBe(true);
  });
});

describe('variantAt', () => {
  it('gives the same image for the same index, every time', async () => {
    const signature = await makeSignature();
    const a = await variantAt(signature, 2);
    const b = await variantAt(signature, 2);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('matches what the signer was shown for that index', async () => {
    // The whole point of indexing by number alone: the variant approved on the
    // phone must be the variant stamped on the document.
    const signature = await makeSignature();
    const shown = await generateVariants(signature, 3);
    for (const variant of shown) {
      const stamped = await variantAt(signature, variant.index);
      const asDataUrl = `data:image/png;base64,${Buffer.from(stamped).toString('base64')}`;
      expect(asDataUrl).toBe(variant.dataUrl);
    }
  });

  it('gives different images for different indexes', async () => {
    const signature = await makeSignature();
    const zero = await variantAt(signature, 0);
    const one = await variantAt(signature, 1);
    expect(Buffer.from(zero).equals(Buffer.from(one))).toBe(false);
  });
});

describe('fallbackVariantIndex', () => {
  it('is stable for a document and stays in range', () => {
    for (const count of [1, 3, 10]) {
      const index = fallbackVariantIndex('doc-abc', count);
      expect(index).toBe(fallbackVariantIndex('doc-abc', count));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(count);
    }
  });

  it('spreads documents across the available variants', () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => fallbackVariantIndex(`doc-${i}`, 4)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

/**
 * Several overlapping strokes of differing weight — closer to handwriting than
 * a single smooth arc, which has almost no interior and so barely registers a
 * change in pen weight.
 */
const makeHandwriting = async (width = 600, height = 170) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <path d="M 30 120 C 70 40, 110 140, 150 70 S 210 110, 250 60"
      fill="none" stroke="#1a1a22" stroke-width="9" stroke-linecap="round"/>
    <path d="M 260 90 C 300 30, 340 130, 380 60 S 440 100, 470 55"
      fill="none" stroke="#1a1a22" stroke-width="7" stroke-linecap="round"/>
    <path d="M 60 135 L 520 118" fill="none" stroke="#1a1a22" stroke-width="4"
      stroke-linecap="round"/>
    <path d="M 480 70 C 510 50, 540 90, 570 65" fill="none" stroke="#1a1a22"
      stroke-width="6" stroke-linecap="round"/>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
};

describe('natural variation', () => {
  /** Share of ink pixels that actually moved between two variants. */
  const visibleDifference = async (a: Uint8Array, b: Uint8Array) => {
    const norm = (x: Uint8Array) =>
      sharp(Buffer.from(x)).resize(600, 180, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    const [pa, pb] = [await norm(a), await norm(b)];
    let ink = 0;
    let moved = 0;
    for (let i = 3; i < pa.length; i += 4) {
      if (pa[i]! > 32 || pb[i]! > 32) ink += 1;
      if (Math.abs(pa[i]! - pb[i]!) > 64) moved += 1;
    }
    return moved / (ink || 1);
  };

  it('produces variants that differ to the eye, not just in bytes', async () => {
    // Rotation and scale alone gave variants that differed as files but were
    // indistinguishable side by side — 13% of ink moved in the worst pair.
    const handwriting = await makeHandwriting();
    const variants = await Promise.all(
      [0, 1, 2, 3].map((i) => applyVariant(handwriting, variantParamsFor(`variant:${i}`))),
    );

    for (let i = 1; i < variants.length; i++) {
      const share = await visibleDifference(variants[0]!, variants[i]!);
      expect(share).toBeGreaterThan(0.3);
    }
  });

  it('varies the pen, not the letterforms', async () => {
    // The visible difference has to come from weight and ink density. An
    // earlier version got it from a displacement field instead, and the
    // signature rippled — which is not something a hand does.
    const handwriting = await makeHandwriting();
    const coverage = async (png: Uint8Array) => {
      const { data, info } = await sharp(Buffer.from(png))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let sum = 0;
      let n = 0;
      for (let i = 3; i < data.length; i += info.channels) {
        if (data[i]! < 8) continue;
        sum += data[i]!;
        n += 1;
      }
      return { mean: sum / (n || 1), pixels: n };
    };

    const measures = await Promise.all(
      [0, 1, 2, 3].map(async (i) =>
        coverage(await applyVariant(handwriting, variantParamsFor(`variant:${i}`))),
      ),
    );

    // Ink weight must genuinely differ between variants…
    const means = measures.map((m) => m.mean);
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThan(6);

    // …while the mark keeps its size: the shapes are not being bent.
    const areas = measures.map((m) => m.pixels);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.8);
  });

  it('bends the mark without eating it', async () => {
    const signature = await makeSignature(600, 180);
    const inkMass = async (png: Uint8Array) => {
      const { data, info } = await sharp(Buffer.from(png))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let i = 3; i < data.length; i += info.channels) if (data[i]! > 32) n += 1;
      return n;
    };
    const base = await inkMass(signature);
    for (const seed of ['a', 'b', 'c', 'd']) {
      const mass = await inkMass(await applyVariant(signature, variantParamsFor(seed)));
      // Bilinear resampling spreads strokes a little; losing the mark or
      // doubling it would both mean the warp is wrong.
      expect(mass).toBeGreaterThan(base * 0.8);
      expect(mass).toBeLessThan(base * 1.6);
    }
  });

  it('keeps the warp reproducible', async () => {
    const signature = await makeSignature(400, 120);
    const a = await applyVariant(signature, variantParamsFor('same'));
    const b = await applyVariant(signature, variantParamsFor('same'));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('generateVariants', () => {
  it('returns distinct data URLs the signer can compare', async () => {
    const signature = await makeSignature();
    const previews = await generateVariants(signature, 4);
    expect(previews).toHaveLength(4);
    for (const p of previews) expect(p.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(new Set(previews.map((p) => p.dataUrl)).size).toBe(4);
  });
});
