import { describe, expect, it } from 'vitest';
import { validateDocumentDetection } from '../src/utils/documentValidation';
import type { Corners } from '../src/types/scanner';

/** An upright page filling `coverage` of the frame, centred. */
const page = (coverage: number, aspect = 0.7): Corners => {
  // area = w*h with h = w/aspect (portrait), so w = sqrt(coverage * aspect)
  const w = Math.sqrt(coverage * aspect);
  const h = w / aspect;
  const x0 = (1 - w) / 2;
  const y0 = (1 - h) / 2;
  return {
    topLeft: { x: x0, y: y0 },
    topRight: { x: x0 + w, y: y0 },
    bottomRight: { x: x0 + w, y: y0 + h },
    bottomLeft: { x: x0, y: y0 + h },
  };
};

describe('validateDocumentDetection', () => {
  it('case 1 — a well framed page is framed', () => {
    expect(validateDocumentDetection(page(0.5)).status).toBe('framed');
  });

  it('case 2 — a corner outside the frame is partial', () => {
    const c = page(0.5);
    c.topRight.x = 1.02;
    expect(validateDocumentDetection(c).status).toBe('partial');
    // …and a corner sitting on the very edge counts the same: we did not see it.
    const edge = page(0.5);
    edge.bottomLeft.y = 0.999;
    expect(validateDocumentDetection(edge).status).toBe('partial');
  });

  it('case 3 — no corners (three would never reach us) is searching', () => {
    expect(validateDocumentDetection(null).status).toBe('searching');
    const c = page(0.5);
    c.topLeft = { x: Number.NaN, y: 0.2 };
    expect(validateDocumentDetection(c).status).toBe('searching');
  });

  it('case 4 — too small asks to come closer', () => {
    expect(validateDocumentDetection(page(0.08)).status).toBe('too_small');
  });

  it('too close asks to step back', () => {
    // Square-ish and almost edge to edge: inside the margins, yet too much of the frame.
    expect(validateDocumentDetection(page(0.95, 1)).status).toBe('too_close');
  });

  it('a steep perspective is tilted', () => {
    const c = page(0.45);
    // Squash the top edge: the page is seen from far below.
    c.topLeft.x += 0.22;
    c.topRight.x -= 0.22;
    expect(validateDocumentDetection(c).status).toBe('tilted');
  });

  it('a bow-tie quad is not a page', () => {
    const c = page(0.5);
    const tr = c.topRight;
    c.topRight = c.bottomRight;
    c.bottomRight = tr;
    expect(validateDocumentDetection(c).status).toBe('searching');
  });

  it('reports coverage so the UI can nudge closer or farther', () => {
    expect(validateDocumentDetection(page(0.5)).coverage).toBeCloseTo(0.5, 6);
  });
});
