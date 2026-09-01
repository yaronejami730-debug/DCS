import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  clearModelCache,
  fitSignature,
  lognormal,
  modelSignature,
  perturb,
  reconstructRun,
  reconstructionError,
  synthesizeVariant,
  thin,
  traceSignature,
} from '../src/services/synsig/index.js';

/**
 * A cursive mark: connected loops, a descender and an underline flourish.
 * Closer to a real signature than a single arc, which has too little structure
 * for a stroke decomposition to say anything interesting about.
 */
const makeCursive = async (width = 760, height = 240) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <g fill="none" stroke="#101a33" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 60 175 C 66 110, 96 66, 124 74 C 150 82, 138 138, 118 166
               C 100 192, 86 186, 96 160 C 110 124, 152 106, 186 128
               C 214 146, 200 178, 224 176 C 248 174, 254 120, 282 118
               C 306 116, 300 168, 324 170 C 350 172, 356 104, 386 108"
            stroke-width="7"/>
      <path d="M 386 108 C 414 112, 404 172, 428 172 C 456 172, 452 106, 484 112
               C 512 118, 500 176, 528 174 C 560 172, 556 96, 596 104
               C 626 110, 612 190, 588 214 C 570 232, 552 224, 560 200"
            stroke-width="6"/>
      <path d="M 92 206 C 220 190, 400 200, 640 176 C 672 172, 690 164, 700 150"
            stroke-width="4.5"/>
    </g>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
};

const raw = async (png: Uint8Array) =>
  sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

const inkPixels = async (png: Uint8Array) => {
  const { data } = await raw(png);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 32) n += 1;
  return n;
};

describe('thin', () => {
  it('reduces a thick bar to a single-pixel spine', () => {
    const width = 60;
    const height = 24;
    const mask = new Uint8Array(width * height);
    for (let y = 8; y < 16; y++) for (let x = 6; x < 54; x++) mask[y * width + x] = 1;

    const skeleton = thin(mask, width, height);

    // Every column of the bar keeps ink, but only a sliver of it.
    let before = 0;
    let after = 0;
    for (let i = 0; i < mask.length; i++) {
      before += mask[i]!;
      after += skeleton[i]!;
    }
    expect(after).toBeGreaterThan(30);
    expect(after).toBeLessThan(before / 4);

    // No column carries more than a couple of skeleton pixels.
    for (let x = 10; x < 50; x++) {
      let column = 0;
      for (let y = 0; y < height; y++) column += skeleton[y * width + x]!;
      expect(column).toBeLessThanOrEqual(2);
    }
  });

  it('keeps a loop connected rather than snapping it open', () => {
    const size = 48;
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x - 24, y - 24);
        if (r > 12 && r < 18) mask[y * size + x] = 1;
      }
    }
    const skeleton = thin(mask, size, size);

    let count = 0;
    for (let i = 0; i < skeleton.length; i++) count += skeleton[i]!;
    // A ring of radius ~15 has a circumference near 94; a broken thinning
    // would leave far fewer.
    expect(count).toBeGreaterThan(60);
  });
});

describe('traceSignature', () => {
  it('recovers pen-down runs with monotonic timing', async () => {
    const png = await makeCursive();
    const { data, info } = await raw(png);
    const trajectory = traceSignature(data, info.width, info.height);

    expect(trajectory).not.toBeNull();
    expect(trajectory!.strokes.length).toBeGreaterThan(0);
    expect(trajectory!.penRadius).toBeGreaterThan(1);

    for (const stroke of trajectory!.strokes) {
      expect(stroke.samples.length).toBeGreaterThan(3);
      for (let i = 1; i < stroke.samples.length; i++) {
        expect(stroke.samples[i]!.t).toBeGreaterThan(stroke.samples[i - 1]!.t);
      }
    }
  });

  it('places every sample inside the image', async () => {
    const png = await makeCursive();
    const { data, info } = await raw(png);
    const trajectory = traceSignature(data, info.width, info.height)!;

    for (const stroke of trajectory.strokes) {
      for (const p of stroke.samples) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(info.width);
        expect(p.y).toBeLessThanOrEqual(info.height);
      }
    }
  });

  it('returns null for an empty cutout rather than inventing a stroke', async () => {
    const blank = new Uint8Array(
      await sharp({
        create: { width: 120, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    );
    const { data, info } = await raw(blank);
    expect(traceSignature(data, info.width, info.height)).toBeNull();
  });
});

describe('lognormal', () => {
  it('is a probability density — it integrates to one', () => {
    const stroke = { D: 1, t0: 0, mu: -1.6, sigma: 0.22, thetaS: 0, thetaE: 0 };
    const dt = 0.0002;
    let area = 0;
    for (let t = dt; t < 4; t += dt) area += lognormal(stroke, t) * dt;
    expect(area).toBeGreaterThan(0.99);
    expect(area).toBeLessThan(1.01);
  });

  it('contributes nothing before its onset', () => {
    const stroke = { D: 1, t0: 0.5, mu: -1.6, sigma: 0.22, thetaS: 0, thetaE: 0 };
    expect(lognormal(stroke, 0.4)).toBe(0);
    expect(lognormal(stroke, 0.5)).toBe(0);
    expect(lognormal(stroke, 0.7)).toBeGreaterThan(0);
  });
});

describe('fitSignature', () => {
  it('explains the traced pen to within a few percent of the mark height', async () => {
    const png = await makeCursive();
    const { data, info } = await raw(png);
    const trajectory = traceSignature(data, info.width, info.height)!;
    const model = fitSignature(trajectory)!;

    expect(model).not.toBeNull();

    const components = model.runs.reduce((n, run) => n + run.components.length, 0);
    expect(components).toBeGreaterThan(10);

    // The whole engine rests on this number. Fitting each velocity bump
    // independently — ignoring that lognormal tails overlap — put it above 70%,
    // which is a reconstruction that has left the page.
    expect(reconstructionError(model)).toBeLessThan(0.05);
  });

  it('produces physiologically plausible stroke parameters', async () => {
    const png = await makeCursive();
    const { data, info } = await raw(png);
    const model = fitSignature(traceSignature(data, info.width, info.height)!)!;

    for (const run of model.runs) {
      for (const stroke of run.components) {
        expect(stroke.D).toBeGreaterThan(0);
        expect(stroke.sigma).toBeGreaterThan(0.05);
        expect(stroke.sigma).toBeLessThan(0.9);
        expect(stroke.t0).toBeLessThan(run.end);
        // An arc, not a pirouette.
        expect(Math.abs(stroke.thetaE - stroke.thetaS)).toBeLessThanOrEqual(2.3);
      }
    }
  });
});

describe('perturb', () => {
  it('is deterministic, and different seeds give different movements', async () => {
    const png = await makeCursive();
    const { data, info } = await raw(png);
    const model = fitSignature(traceSignature(data, info.width, info.height)!)!;

    const a = perturb(model, 'synsig:1');
    const b = perturb(model, 'synsig:1');
    const c = perturb(model, 'synsig:2');

    expect(a.runs[0]!.components).toEqual(b.runs[0]!.components);
    expect(a.runs[0]!.components).not.toEqual(c.runs[0]!.components);
  });

  it('moves the motor parameters without leaving the signature behind', async () => {
    const png = await makeCursive();
    const { data, info } = await raw(png);
    const model = fitSignature(traceSignature(data, info.width, info.height)!)!;
    const varied = perturb(model, 'synsig:3');

    for (let r = 0; r < model.runs.length; r++) {
      const base = model.runs[r]!.components;
      const other = varied.runs[r]!.components;
      expect(other).toHaveLength(base.length);

      for (let i = 0; i < base.length; i++) {
        const from = base[i]!;
        const to = other[i]!;
        // Amplitude moves, but by a hand's worth: the default range allows
        // 7.5% per stroke plus 3% overall.
        expect(to.D / from.D).toBeGreaterThan(0.85);
        expect(to.D / from.D).toBeLessThan(1.15);
        expect(Math.abs(to.thetaS - from.thetaS)).toBeLessThan(0.09);
        expect(to.sigma / from.sigma).toBeGreaterThan(0.85);
        expect(to.sigma / from.sigma).toBeLessThan(1.15);
        // Onset is never touched: reordering the commands would rewrite the
        // signature rather than vary it.
        expect(to.t0).toBe(from.t0);
      }
    }
  });

  it('actually displaces the reconstructed pen', async () => {
    const png = await makeCursive();
    const { data, info } = await raw(png);
    const model = fitSignature(traceSignature(data, info.width, info.height)!)!;
    const varied = perturb(model, 'synsig:0');

    const before = reconstructRun(model.runs[0]!);
    const after = reconstructRun(varied.runs[0]!);

    let maxShift = 0;
    for (let i = 0; i < before.length; i++) {
      maxShift = Math.max(maxShift, Math.hypot(before[i]!.x - after[i]!.x, before[i]!.y - after[i]!.y));
    }
    // Visible, but nowhere near a different signature.
    expect(maxShift).toBeGreaterThan(1.5);
    expect(maxShift).toBeLessThan(info.height * 0.35);
  });
});

describe('synthesizeVariant', () => {
  it('produces a variant that keeps its transparency', async () => {
    const png = await makeCursive();
    const variant = (await synthesizeVariant(png, 0))!;
    expect(variant).not.toBeNull();

    const meta = await sharp(Buffer.from(variant)).metadata();
    expect(meta.hasAlpha).toBe(true);

    const { data } = await raw(variant);
    expect(data[3]!).toBeLessThan(32);
  });

  it('is deterministic — variant n is always the same image', async () => {
    const png = await makeCursive();
    clearModelCache();
    const first = (await synthesizeVariant(png, 2))!;
    clearModelCache();
    const second = (await synthesizeVariant(png, 2))!;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('keeps the same amount of ink on the page', async () => {
    const png = await makeCursive();
    const base = await inkPixels(png);
    for (const index of [0, 1, 2, 3, 4]) {
      const variant = (await synthesizeVariant(png, index))!;
      const mass = await inkPixels(variant);
      expect(mass).toBeGreaterThan(base * 0.75);
      expect(mass).toBeLessThan(base * 1.5);
    }
  });

  it('gives variants that differ from one another to the eye', async () => {
    const png = await makeCursive();
    const variants = await Promise.all([0, 1, 2, 3].map((i) => synthesizeVariant(png, i)));

    const normalise = (x: Uint8Array) =>
      sharp(Buffer.from(x)).resize(600, 190, { fit: 'fill' }).ensureAlpha().raw().toBuffer();

    for (let i = 1; i < variants.length; i++) {
      const [a, b] = [await normalise(variants[0]!), await normalise(variants[i]!)];
      let ink = 0;
      let moved = 0;
      for (let p = 3; p < a.length; p += 4) {
        if (a[p]! > 32 || b[p]! > 32) ink += 1;
        if (Math.abs(a[p]! - b[p]!) > 64) moved += 1;
      }
      expect(moved / (ink || 1)).toBeGreaterThan(0.25);
    }
  });

  it('returns null on something it cannot model, so the caller can fall back', async () => {
    expect(await synthesizeVariant(new Uint8Array([1, 2, 3, 4, 5]), 0)).toBeNull();

    const speck = new Uint8Array(
      await sharp({
        create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    );
    expect(await synthesizeVariant(speck, 0)).toBeNull();
  });
});

describe('modelSignature', () => {
  it('caches, so a spread of variants traces the mark once', async () => {
    const png = await makeCursive();
    clearModelCache();

    const started = Date.now();
    const first = await modelSignature(png);
    const cold = Date.now() - started;

    const again = Date.now();
    const second = await modelSignature(png);
    const warm = Date.now() - again;

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(warm).toBeLessThanOrEqual(Math.max(2, cold));
  });
});
