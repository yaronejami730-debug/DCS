import { describe, expect, it } from 'vitest';
import { assessExposure, assessSharpness, downscaleGrey } from '../src/index.js';

/** A 400×300 "page": white paper with black text-like bars, optionally blurred. */
const page = (blurRadius: number, paper = 235, ink = 30): Uint8Array => {
  const w = 400;
  const h = 300;
  const grey = new Uint8Array(w * h).fill(paper);
  for (let y = 40; y < h - 40; y += 24) {
    for (let x = 30; x < w - 30; x++) {
      for (let dy = 0; dy < 8; dy++) grey[(y + dy) * w + x] = ink;
    }
  }
  if (blurRadius === 0) return grey;
  // Box blur, separable.
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -blurRadius; k <= blurRadius; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) {
          s += grey[y * w + xx]!;
          n++;
        }
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -blurRadius; k <= blurRadius; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) {
          s += tmp[yy * w + x]!;
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
};

describe('assessSharpness', () => {
  it('rates crisp ink ok and heavily blurred ink bad, in that order', () => {
    const crisp = assessSharpness(page(0), 400, 300);
    const soft = assessSharpness(page(3), 400, 300);
    const mush = assessSharpness(page(9), 400, 300);
    expect(crisp.level).toBe('ok');
    expect(mush.level).toBe('bad');
    expect(crisp.score).toBeGreaterThan(soft.score);
    expect(soft.score).toBeGreaterThan(mush.score);
  });
});

describe('assessExposure', () => {
  it('accepts paper under room light and flags dark or blown-out frames', () => {
    expect(assessExposure(page(0)).level).toBe('ok');
    expect(assessExposure(page(0, 60, 10)).level).toBe('bad');
    const blown = new Uint8Array(400 * 300).fill(254);
    expect(assessExposure(blown).level).toBe('bad');
  });
});

describe('downscaleGrey', () => {
  it('box-averages to roughly the target width and keeps the mean', () => {
    const src = page(0);
    const small = downscaleGrey(src, 400, 300, 100);
    expect(small.width).toBe(100);
    expect(small.height).toBe(75);
    const mean = (g: Uint8Array) => g.reduce((s, v) => s + v, 0) / g.length;
    expect(Math.abs(mean(small.grey) - mean(src))).toBeLessThan(2);
  });
});
