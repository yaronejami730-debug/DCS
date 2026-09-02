import { describe, expect, it } from 'vitest';
import { StabilityTracker } from '../src/hooks/useScannerStability';
import type { Corners } from '../src/types/scanner';

const still: Corners = {
  topLeft: { x: 0.2, y: 0.2 },
  topRight: { x: 0.8, y: 0.2 },
  bottomRight: { x: 0.8, y: 0.8 },
  bottomLeft: { x: 0.2, y: 0.8 },
};
const shifted = (dx: number): Corners => ({
  topLeft: { x: still.topLeft.x + dx, y: still.topLeft.y },
  topRight: { x: still.topRight.x + dx, y: still.topRight.y },
  bottomRight: { x: still.bottomRight.x + dx, y: still.bottomRight.y },
  bottomLeft: { x: still.bottomLeft.x + dx, y: still.bottomLeft.y },
});

describe('StabilityTracker', () => {
  it('case 6 — a page held still for the window becomes stable, not before', () => {
    const t = new StabilityTracker({ holdMs: 600, maxJitter: 0.02 });
    expect(t.push(true, still, 0)).toBe('settling');
    expect(t.push(true, still, 300)).toBe('settling');
    expect(t.push(true, still, 599)).toBe('settling');
    expect(t.push(true, still, 600)).toBe('stable');
    expect(t.push(true, still, 900)).toBe('stable');
  });

  it('case 5 — a moving phone restarts the clock', () => {
    const t = new StabilityTracker({ holdMs: 600, maxJitter: 0.02 });
    t.push(true, still, 0);
    t.push(true, still, 400);
    expect(t.push(true, shifted(0.1), 500)).toBe('moving');
    expect(t.push(true, shifted(0.1), 900)).toBe('settling');
    expect(t.push(true, shifted(0.1), 1100)).toBe('stable');
  });

  it('tolerates hand tremor below the jitter threshold', () => {
    const t = new StabilityTracker({ holdMs: 600, maxJitter: 0.02 });
    t.push(true, still, 0);
    expect(t.push(true, shifted(0.005), 300)).toBe('settling');
    expect(t.push(true, shifted(0.0), 650)).toBe('stable');
  });

  it('case 7 — a frame that stops being framed drops to idle at once', () => {
    const t = new StabilityTracker({ holdMs: 600, maxJitter: 0.02 });
    t.push(true, still, 0);
    expect(t.push(true, still, 700)).toBe('stable');
    expect(t.push(false, null, 750)).toBe('idle');
    // …and has to earn the window again.
    expect(t.push(true, still, 800)).toBe('settling');
  });
});
