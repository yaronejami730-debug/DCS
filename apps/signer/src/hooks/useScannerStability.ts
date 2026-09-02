import { useRef } from 'react';
import { DEFAULT_STABILITY, type Corners, type StabilityOptions } from '../types/scanner';
import { maxCornerDisplacement } from '../utils/perspective';

/**
 * The stability window.
 *
 * A single good frame is not a reason to arm the shutter: the next one may be
 * a smear. The document has to stay framed AND still for `holdMs` before the
 * scanner says ready — and it drops back to not-ready the instant a frame is
 * bad or the corners jump. That is also what stops the button flickering
 * between enabled and disabled while the hand settles.
 *
 * Plain class, no React inside, so it is testable with fake clocks; the hook
 * below only keeps one instance alive across renders.
 */
export type StabilityVerdict = 'idle' | 'moving' | 'settling' | 'stable';

export class StabilityTracker {
  private since: number | null = null;
  private last: Corners | null = null;

  constructor(private readonly options: StabilityOptions = DEFAULT_STABILITY) {}

  /**
   * Feed one frame. `framed` says the geometry passed; `corners` are the
   * normalized corners (null when none). Returns where the window stands.
   */
  push(framed: boolean, corners: Corners | null, now: number): StabilityVerdict {
    if (!framed || !corners) {
      this.reset();
      return 'idle';
    }
    // Jitter: normalized corners, so the frame diagonal is sqrt(2).
    const moved = this.last ? maxCornerDisplacement(this.last, corners) / Math.SQRT2 : 0;
    this.last = corners;
    if (moved > this.options.maxJitter) {
      // Restart the clock; the page is still there but the hand is not still.
      this.since = now;
      return 'moving';
    }
    if (this.since === null) this.since = now;
    return now - this.since >= this.options.holdMs ? 'stable' : 'settling';
  }

  reset(): void {
    this.since = null;
    this.last = null;
  }
}

export const useScannerStability = (options: StabilityOptions = DEFAULT_STABILITY) => {
  const ref = useRef<StabilityTracker | null>(null);
  if (!ref.current) ref.current = new StabilityTracker(options);
  return ref.current;
};
