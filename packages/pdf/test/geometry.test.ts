import { describe, expect, it } from 'vitest';
import {
  computeImagePlacement,
  MARK_NATURAL_SIZE,
  containFit,
  fitMarkInZone,
  applyMarkVariation,
  NO_VARIATION,
  normalizedToPdfRect,
  normalizedToPixelRect,
  normalizeRotation,
  screenToNormalizedRect,
  viewportSize,
} from '../src/geometry.js';

// A4 in points.
const A4 = { width: 595.28, height: 841.89 };

describe('normalizeRotation', () => {
  it('snaps to the four legal PDF rotations', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
  });
});

describe('viewportSize', () => {
  it('swaps width and height for quarter turns only', () => {
    expect(viewportSize(600, 800, 0)).toEqual({ width: 600, height: 800 });
    expect(viewportSize(600, 800, 180)).toEqual({ width: 600, height: 800 });
    expect(viewportSize(600, 800, 90)).toEqual({ width: 800, height: 600 });
    expect(viewportSize(600, 800, 270)).toEqual({ width: 800, height: 600 });
  });
});

describe('screenToNormalizedRect', () => {
  it('is independent of the display size — the whole point of normalizing', () => {
    // Same zone drawn on a small phone and a large desktop canvas.
    const onPhone = screenToNormalizedRect({ x: 78, y: 156, width: 39, height: 26 }, 390, 520);
    const onDesktop = screenToNormalizedRect(
      { x: 240, y: 480, width: 120, height: 80 },
      1200,
      1600,
    );
    expect(onPhone.x).toBeCloseTo(onDesktop.x, 6);
    expect(onPhone.y).toBeCloseTo(onDesktop.y, 6);
    expect(onPhone.width).toBeCloseTo(onDesktop.width, 6);
    expect(onPhone.height).toBeCloseTo(onDesktop.height, 6);
  });

  it('rejects a zero-sized container instead of emitting Infinity', () => {
    expect(() => screenToNormalizedRect({ x: 0, y: 0, width: 1, height: 1 }, 0, 10)).toThrow();
  });
});

describe('normalizedToPixelRect', () => {
  it('rounds to whole pixels and never runs past the image edge', () => {
    const r = normalizedToPixelRect({ x: 0.9, y: 0.9, width: 0.2, height: 0.2 }, 1000, 500);
    expect(r.x).toBe(900);
    expect(r.y).toBe(450);
    expect(r.x + r.width).toBeLessThanOrEqual(1000);
    expect(r.y + r.height).toBeLessThanOrEqual(500);
  });
});

describe('normalizedToPdfRect', () => {
  it('flips the y axis for an unrotated page', () => {
    // Zone at the very top-left of the viewport.
    const rect = normalizedToPdfRect({ x: 0, y: 0, width: 0.5, height: 0.1 }, 600, 800, 0);
    expect(rect.x).toBeCloseTo(0);
    // top of the page in PDF space is y = pageHeight, minus the zone height
    expect(rect.y).toBeCloseTo(800 - 80);
    expect(rect.width).toBeCloseTo(300);
    expect(rect.height).toBeCloseTo(80);
  });

  it('puts a bottom-right zone near the origin corner in PDF space', () => {
    const rect = normalizedToPdfRect({ x: 0.8, y: 0.9, width: 0.2, height: 0.1 }, 600, 800, 0);
    expect(rect.x).toBeCloseTo(480);
    expect(rect.y).toBeCloseTo(0);
  });

  it('keeps a real-world signature zone inside an A4 page', () => {
    const rect = normalizedToPdfRect(
      { x: 0.72, y: 0.81, width: 0.2, height: 0.08 },
      A4.width,
      A4.height,
      0,
    );
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.y).toBeGreaterThan(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(A4.width + 1e-6);
    expect(rect.y + rect.height).toBeLessThanOrEqual(A4.height + 1e-6);
  });

  it('maps the viewport top-left corner to the correct user-space corner for every rotation', () => {
    const tinyTopLeft = { x: 0, y: 0, width: 0.01, height: 0.01 };
    const W = 600;
    const H = 800;

    // rotation 0: viewport top-left is user top-left -> (0, H)
    const r0 = normalizedToPdfRect(tinyTopLeft, W, H, 0);
    expect(r0.x).toBeCloseTo(0);
    expect(r0.y + r0.height).toBeCloseTo(H);

    // rotation 90: viewport top-left is user BOTTOM-left -> (0, 0)
    const r90 = normalizedToPdfRect(tinyTopLeft, W, H, 90);
    expect(r90.x).toBeCloseTo(0);
    expect(r90.y).toBeCloseTo(0);

    // rotation 180: viewport top-left is user bottom-RIGHT -> (W, 0)
    const r180 = normalizedToPdfRect(tinyTopLeft, W, H, 180);
    expect(r180.x + r180.width).toBeCloseTo(W);
    expect(r180.y).toBeCloseTo(0);

    // rotation 270: viewport top-left is user TOP-right -> (W, H)
    const r270 = normalizedToPdfRect(tinyTopLeft, W, H, 270);
    expect(r270.x + r270.width).toBeCloseTo(W);
    expect(r270.y + r270.height).toBeCloseTo(H);
  });

  it('swaps width and height on quarter turns', () => {
    const r = normalizedToPdfRect({ x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, 600, 800, 90);
    // viewport is 800x600, so the zone is 320 wide x 120 tall on screen,
    // which becomes 120 x 320 in unrotated user space.
    expect(r.width).toBeCloseTo(120);
    expect(r.height).toBeCloseTo(320);
  });

  it('always stays within the page box, whatever the rotation', () => {
    const rect = { x: 0.05, y: 0.62, width: 0.3, height: 0.12 };
    for (const rotation of [0, 90, 180, 270] as const) {
      const r = normalizedToPdfRect(rect, 600, 800, rotation);
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.width).toBeLessThanOrEqual(600 + 1e-6);
      expect(r.y + r.height).toBeLessThanOrEqual(800 + 1e-6);
    }
  });
});

describe('containFit', () => {
  it('never distorts: the output aspect ratio matches the source', () => {
    const box = { x: 10, y: 20, width: 200, height: 100 };
    const fitted = containFit(400, 100, box); // very wide signature
    expect(fitted.width / fitted.height).toBeCloseTo(4, 6);
    expect(fitted.width).toBeCloseTo(200);
    expect(fitted.height).toBeCloseTo(50);
  });

  it('centres the fitted image inside the zone', () => {
    const box = { x: 10, y: 20, width: 200, height: 100 };
    const fitted = containFit(400, 100, box);
    expect(fitted.x).toBeCloseTo(10);
    expect(fitted.y).toBeCloseTo(20 + (100 - 50) / 2);
  });

  it('never overflows the zone', () => {
    const box = { x: 0, y: 0, width: 120, height: 50 };
    for (const [w, h] of [
      [1000, 10],
      [10, 1000],
      [50, 50],
    ] as const) {
      const fitted = containFit(w, h, box);
      expect(fitted.width).toBeLessThanOrEqual(box.width + 1e-9);
      expect(fitted.height).toBeLessThanOrEqual(box.height + 1e-9);
    }
  });

  it('rejects a degenerate source', () => {
    expect(() => containFit(0, 10, { x: 0, y: 0, width: 10, height: 10 })).toThrow();
  });
});

describe('computeImagePlacement', () => {
  const zone = { x: 0.72, y: 0.81, width: 0.2, height: 0.08 };

  it('produces an unrotated placement inside the page for a normal page', () => {
    const p = computeImagePlacement({
      rect: zone,
      pageWidth: A4.width,
      pageHeight: A4.height,
      rotation: 0,
      imageWidth: 600,
      imageHeight: 200,
    });
    expect(p.rotateDegrees).toBe(0);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(A4.width + 1e-6);
    expect(p.y + p.height).toBeLessThanOrEqual(A4.height + 1e-6);
    expect(p.width / p.height).toBeCloseTo(3, 6);
  });

  /**
   * Replays pdf-lib's own transform (translate then rotate CCW about the draw
   * origin) so we can assert where the image actually lands on the page.
   */
  const drawnBounds = (p: ReturnType<typeof computeImagePlacement>) => {
    const rad = (p.rotateDegrees * Math.PI) / 180;
    const cos = Math.round(Math.cos(rad));
    const sin = Math.round(Math.sin(rad));
    const corners = [
      [0, 0],
      [p.width, 0],
      [0, p.height],
      [p.width, p.height],
    ].map(([lx, ly]) => ({
      x: p.x + lx! * cos - ly! * sin,
      y: p.y + lx! * sin + ly! * cos,
    }));
    return {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxY: Math.max(...corners.map((c) => c.y)),
    };
  };

  it.each([0, 90, 180, 270] as const)(
    'lands inside the page and matches the plain rect conversion at rotation %i',
    (rotation) => {
      const W = 600;
      const H = 800;
      // A square image in a square-ish zone so contain-fit fills the whole box,
      // letting us compare against normalizedToPdfRect exactly.
      const squareZone = { x: 0.2, y: 0.3, width: 0.25, height: 0.25 };
      const vp = viewportSize(W, H, rotation);
      const imageAspect = (squareZone.width * vp.width) / (squareZone.height * vp.height);

      const p = computeImagePlacement({
        rect: squareZone,
        pageWidth: W,
        pageHeight: H,
        rotation,
        imageWidth: 100 * imageAspect,
        imageHeight: 100,
      });

      const bounds = drawnBounds(p);
      const expected = normalizedToPdfRect(squareZone, W, H, rotation);

      expect(bounds.minX).toBeCloseTo(expected.x, 4);
      expect(bounds.minY).toBeCloseTo(expected.y, 4);
      expect(bounds.maxX - bounds.minX).toBeCloseTo(expected.width, 4);
      expect(bounds.maxY - bounds.minY).toBeCloseTo(expected.height, 4);

      expect(bounds.minX).toBeGreaterThanOrEqual(-1e-6);
      expect(bounds.minY).toBeGreaterThanOrEqual(-1e-6);
      expect(bounds.maxX).toBeLessThanOrEqual(W + 1e-6);
      expect(bounds.maxY).toBeLessThanOrEqual(H + 1e-6);
    },
  );

  it('spins the image so it reads upright on a rotated page', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const p = computeImagePlacement({
        rect: zone,
        pageWidth: 600,
        pageHeight: 800,
        rotation,
        imageWidth: 300,
        imageHeight: 100,
      });
      expect(p.rotateDegrees).toBe(rotation);
    }
  });
});

/**
 * Sizing a mark inside the zone drawn for it.
 *
 * Strict contain-fit was height-led in every real template measured — operators
 * draw a wide flat box along the signature line, and an ink cutout is far less
 * elongated — so marks filled 100% of the zone height and as little as 23% of
 * its width, coming out visibly too small.
 */
describe('fitMarkInZone', () => {
  const zone = { x: 0, y: 0, width: 274, height: 86 };

  it('makes the mark markedly bigger than strict contain did', () => {
    // A signature-over-stamp cutout: 1400x867, aspect 1.61, in a 3.2 box.
    // Strict contain filled barely half the drawn width.
    const strict = containFit(1400, 867, zone);
    const led = fitMarkInZone(1400, 867, zone);

    expect(strict.width / zone.width).toBeLessThan(0.55);
    expect(led.width / zone.width).toBeGreaterThan(0.7);
    expect(led.width).toBeGreaterThan(strict.width * 1.4);
  });

  it('fills the drawn width exactly when the height cap allows it', () => {
    // A flat mark in a flat box: nothing forces a compromise, so the mark
    // occupies precisely the width that was drawn for it.
    const flat = { x: 0, y: 0, width: 284, height: 60 };
    const led = fitMarkInZone(1400, 319, flat);
    expect(led.width).toBeCloseTo(flat.width, 6);
  });

  it('never distorts the mark', () => {
    const shapes: Array<[number, number]> = [
      [1400, 867],
      [1400, 319],
      [300, 900],
    ];
    for (const [w, h] of shapes) {
      const fitted = fitMarkInZone(w, h, zone);
      expect(fitted.width / fitted.height).toBeCloseTo(w / h, 4);
    }
  });

  it('caps how far the mark may grow out of its zone', () => {
    // A near-square mark in a flat box would otherwise tower over the line and
    // reach into the printed text above and below.
    const fitted = fitMarkInZone(900, 900, zone);
    expect(fitted.height / zone.height).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it('stays centred on the zone, above and below', () => {
    const fitted = fitMarkInZone(1400, 867, zone);
    const centreX = fitted.x + fitted.width / 2;
    const centreY = fitted.y + fitted.height / 2;
    expect(centreX).toBeCloseTo(zone.x + zone.width / 2, 6);
    expect(centreY).toBeCloseTo(zone.y + zone.height / 2, 6);
  });

  it('reproduces strict contain when overflow is not allowed', () => {
    const strict = containFit(1400, 867, zone);
    const capped = fitMarkInZone(1400, 867, zone, { fill: 1, maxHeightOverflow: 1 });
    expect(capped.width).toBeCloseTo(strict.width, 6);
    expect(capped.height).toBeCloseTo(strict.height, 6);
  });

  it('does not enlarge a mark that already fills its zone', () => {
    // Tall zone, wide-ish mark: height already binds, so nothing changes.
    const tall = { x: 0, y: 0, width: 180, height: 124 };
    const strict = containFit(1400, 867, tall);
    const led = fitMarkInZone(1400, 867, tall);
    expect(led.width).toBeLessThanOrEqual(strict.width);
  });

  it('rejects a source with no size rather than dividing by zero', () => {
    expect(() => fitMarkInZone(0, 100, zone)).toThrow();
  });
});

/**
 * Per-signing variation, applied where it survives.
 *
 * The cutout is trimmed to its ink and then fitted into its zone, and those two
 * steps normalise away exactly a scale and a translation — which is why varying
 * the image itself produced marks that measured as different and looked
 * identical. Applied to the placement, nothing divides it out again.
 */
describe('applyMarkVariation', () => {
  const base = { x: 100, y: 200, width: 180, height: 60, rotateDegrees: 0 };

  it('leaves a placement alone when there is nothing to vary', () => {
    expect(applyMarkVariation(base, NO_VARIATION)).toEqual(base);
  });

  it('resizes about the mark centre rather than its corner', () => {
    const scaled = applyMarkVariation(base, { ...NO_VARIATION, scaleX: 1.2, scaleY: 1.2 });
    expect(scaled.width).toBeCloseTo(216, 6);
    expect(scaled.height).toBeCloseTo(72, 6);
    // Centre held: growing a mark must not also walk it across the page.
    expect(scaled.x + scaled.width / 2).toBeCloseTo(base.x + base.width / 2, 6);
    expect(scaled.y + scaled.height / 2).toBeCloseTo(base.y + base.height / 2, 6);
  });

  it('reshapes the strokes when the axes scale differently', () => {
    const squashed = applyMarkVariation(base, { ...NO_VARIATION, scaleX: 1.05, scaleY: 0.95 });
    expect(squashed.width / squashed.height).toBeGreaterThan(base.width / base.height);
  });

  it('offsets along the mark, in fractions of its own size', () => {
    const moved = applyMarkVariation(base, { ...NO_VARIATION, offsetX: 0.5, offsetY: -0.25 });
    expect(moved.x + moved.width / 2).toBeCloseTo(base.x + base.width / 2 + 90, 6);
    expect(moved.y + moved.height / 2).toBeCloseTo(base.y + base.height / 2 - 15, 6);
  });

  it('tilts about the centre — pdf-lib rotates about the corner', () => {
    // Rotating a drawn image about its anchor also translates it by an amount
    // that grows with its size; recovering the centre first keeps a tilt a tilt.
    const tilted = applyMarkVariation(base, { ...NO_VARIATION, tiltDegrees: 10 });
    const a = (10 * Math.PI) / 180;
    const cx = tilted.x + (tilted.width / 2) * Math.cos(a) - (tilted.height / 2) * Math.sin(a);
    const cy = tilted.y + (tilted.width / 2) * Math.sin(a) + (tilted.height / 2) * Math.cos(a);
    expect(cx).toBeCloseTo(base.x + base.width / 2, 6);
    expect(cy).toBeCloseTo(base.y + base.height / 2, 6);
    expect(tilted.rotateDegrees).toBe(10);
  });

  it('adds its tilt to a page that is already rotated', () => {
    const onRotatedPage = { ...base, rotateDegrees: 90 };
    const tilted = applyMarkVariation(onRotatedPage, { ...NO_VARIATION, tiltDegrees: -2 });
    expect(tilted.rotateDegrees).toBe(88);
  });
});

describe('fitMarkInZone with a natural size', () => {
  const natural = MARK_NATURAL_SIZE.signature;

  it('caps a signature drawn into a generous box at a hand-sized width', () => {
    // A box the width of an A4 footer, 300pt tall: without bounds the mark
    // would span it.
    const box = { x: 40, y: 500, width: 500, height: 300 };
    const fitted = fitMarkInZone(1400, 500, box, { natural });
    expect(fitted.width).toBeLessThanOrEqual(natural.maxWidth + 1e-6);
    expect(fitted.height).toBeLessThanOrEqual(natural.maxHeight + 1e-6);
    // …and stays centred where the zone put it.
    expect(fitted.x + fitted.width / 2).toBeCloseTo(box.x + box.width / 2, 6);
    expect(fitted.y + fitted.height / 2).toBeCloseTo(box.y + box.height / 2, 6);
  });

  it('raises a signature squeezed onto a thin dotted line to a legible height', () => {
    const line = { x: 300, y: 700, width: 120, height: 4 };
    const fitted = fitMarkInZone(1400, 500, line, { natural });
    expect(fitted.height).toBeGreaterThanOrEqual(natural.minHeight - 1e-6);
    expect(fitted.width / fitted.height).toBeCloseTo(1400 / 500, 6);
  });

  it('leaves a normally sized box alone', () => {
    const box = { x: 300, y: 700, width: 140, height: 50 };
    const bounded = fitMarkInZone(1400, 500, box, { natural });
    const free = fitMarkInZone(1400, 500, box);
    expect(bounded).toEqual(free);
  });

  it('keeps every type inside its own maximum, whatever the box', () => {
    for (const [type, size] of Object.entries(MARK_NATURAL_SIZE)) {
      const fitted = fitMarkInZone(1000, 1000, { x: 0, y: 0, width: 595, height: 842 }, { natural: size });
      expect(fitted.width, type).toBeLessThanOrEqual(size.maxWidth + 1e-6);
      expect(fitted.height, type).toBeLessThanOrEqual(size.maxHeight + 1e-6);
    }
  });
});
