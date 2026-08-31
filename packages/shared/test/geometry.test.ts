import { describe, expect, it } from 'vitest';
import {
  clampNormalizedRect,
  isNormalizedRect,
  moveNormalizedRect,
  resizeNormalizedRect,
  type NormalizedRect,
  type RectCorner,
} from '../src/geometry.js';

const inside = (r: NormalizedRect) =>
  r.x >= -1e-9 &&
  r.y >= -1e-9 &&
  r.width >= 0 &&
  r.height >= 0 &&
  r.x + r.width <= 1 + 1e-9 &&
  r.y + r.height <= 1 + 1e-9;

const MIN = 0.05;
const base: NormalizedRect = { x: 0.3, y: 0.3, width: 0.4, height: 0.3 };

describe('moveNormalizedRect', () => {
  it('translates without changing the size', () => {
    const moved = moveNormalizedRect(base, 0.1, -0.1);
    // Compared approximately on purpose: 0.3 + 0.1 is 0.4000000000000001 in
    // binary floating point, and exact equality would fail for no real reason.
    expect(moved.x).toBeCloseTo(0.4);
    expect(moved.y).toBeCloseTo(0.2);
    expect(moved.width).toBeCloseTo(base.width);
    expect(moved.height).toBeCloseTo(base.height);
  });

  it('stops at the edge instead of shrinking', () => {
    const moved = moveNormalizedRect(base, 5, 5);
    expect(moved.width).toBeCloseTo(base.width);
    expect(moved.height).toBeCloseTo(base.height);
    expect(moved.x + moved.width).toBeCloseTo(1);
    expect(moved.y + moved.height).toBeCloseTo(1);
  });

  it('stays inside the photo for any delta', () => {
    for (const dx of [-3, -0.4, 0, 0.4, 3]) {
      for (const dy of [-3, -0.4, 0, 0.4, 3]) {
        expect(inside(moveNormalizedRect(base, dx, dy))).toBe(true);
      }
    }
  });
});

describe('resizeNormalizedRect', () => {
  it('pins the opposite corner when dragging south-east', () => {
    const r = resizeNormalizedRect(base, 'se', 0.1, 0.1, MIN, MIN);
    expect(r.x).toBeCloseTo(base.x);
    expect(r.y).toBeCloseTo(base.y);
    expect(r.width).toBeCloseTo(0.5);
    expect(r.height).toBeCloseTo(0.4);
  });

  it('pins the opposite corner when dragging north-west', () => {
    const r = resizeNormalizedRect(base, 'nw', -0.1, -0.1, MIN, MIN);
    expect(r.x).toBeCloseTo(0.2);
    expect(r.y).toBeCloseTo(0.2);
    // bottom-right must not have moved
    expect(r.x + r.width).toBeCloseTo(base.x + base.width);
    expect(r.y + r.height).toBeCloseTo(base.y + base.height);
  });

  it('moves only the dragged axis for a mixed corner', () => {
    const r = resizeNormalizedRect(base, 'ne', 0.1, -0.1, MIN, MIN);
    expect(r.x).toBeCloseTo(base.x); // west edge pinned
    expect(r.x + r.width).toBeCloseTo(base.x + base.width + 0.1);
    expect(r.y).toBeCloseTo(base.y - 0.1);
    expect(r.y + r.height).toBeCloseTo(base.y + base.height); // south edge pinned
  });

  it('never inverts when dragged past the pinned corner', () => {
    for (const corner of ['nw', 'ne', 'sw', 'se'] as RectCorner[]) {
      const r = resizeNormalizedRect(base, corner, -2, -2, MIN, MIN);
      expect(r.width).toBeGreaterThanOrEqual(MIN - 1e-9);
      expect(r.height).toBeGreaterThanOrEqual(MIN - 1e-9);
      expect(inside(r)).toBe(true);
    }
  });

  it('honours the minimum size from every corner, in both directions', () => {
    for (const corner of ['nw', 'ne', 'sw', 'se'] as RectCorner[]) {
      for (const d of [-1, -0.5, -0.05, 0.05, 0.5, 1]) {
        const r = resizeNormalizedRect(base, corner, d, d, MIN, MIN);
        expect(r.width).toBeGreaterThanOrEqual(MIN - 1e-9);
        expect(r.height).toBeGreaterThanOrEqual(MIN - 1e-9);
        expect(inside(r)).toBe(true);
      }
    }
  });

  it('produces a rect the API will accept', () => {
    for (const corner of ['nw', 'ne', 'sw', 'se'] as RectCorner[]) {
      const r = resizeNormalizedRect(base, corner, 0.17, -0.23, MIN, MIN);
      expect(isNormalizedRect(r)).toBe(true);
    }
  });

  it('clamps a rect dragged hard against a corner of the photo', () => {
    const r = resizeNormalizedRect(
      { x: 0.9, y: 0.9, width: 0.09, height: 0.09 },
      'se',
      5,
      5,
      MIN,
      MIN,
    );
    expect(inside(r)).toBe(true);
    expect(r.x + r.width).toBeCloseTo(1);
  });
});

describe('clampNormalizedRect', () => {
  it('pulls an out-of-bounds rect back inside', () => {
    expect(inside(clampNormalizedRect({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 }))).toBe(true);
  });
});
