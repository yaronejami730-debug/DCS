/**
 * The Sigma-Lognormal model of handwriting, and the parameter perturbation that
 * turns one signature into a family of them.
 *
 * Plamondon's Kinematic Theory of Rapid Human Movements says a rapid aimed
 * movement is the impulse response of a large parallel neuromuscular system,
 * and that its velocity profile converges to a lognormal. A signature is a
 * sequence of such movements overlapping in time, so the pen's velocity is a
 * vector sum of lognormal bursts, each turning the pen along a circular arc:
 *
 *   v(t) = Σ_i D_i · Λ(t; t0_i, μ_i, σ_i) · [cos φ_i(t), sin φ_i(t)]
 *
 *   Λ(t; t0, μ, σ) = 1 / (σ √(2π) (t − t0)) · exp( −(ln(t − t0) − μ)² / (2σ²) )
 *   φ_i(t)         = θs_i + (θe_i − θs_i) · Φ( (ln(t − t0_i) − μ_i) / σ_i )
 *
 * Six numbers per stroke — amplitude, onset, log-time centre, log-time spread,
 * and the arc's start and end direction — describe a whole ballistic movement.
 *
 * That is what makes this different from warping pixels. Perturbing D changes
 * how far a movement carried; perturbing μ and σ changes when it fired and how
 * long it took, which changes how it *overlaps its neighbours*; perturbing θ
 * changes where it aimed. Re-integrating produces a trajectory a hand could
 * have produced on another day — the letterforms reorganise the way real
 * repeated signatures do, instead of every point sliding by a smooth field.
 *
 * Reference points: Plamondon & Djioua, "A multi-level representation paradigm
 * for handwriting stroke generation" (2006); Galbally et al. on synthetic
 * signature duplication; SynSig2Vec (Lai, Jin et al.) for the same generator
 * used as a data-augmentation engine.
 */

import { createHash } from 'node:crypto';
import type { Point, TimedPoint, Trajectory } from './trajectory.js';

export interface LognormalStroke {
  /** Amplitude — the arc length this movement contributes. */
  D: number;
  /** Onset time, before which the stroke contributes nothing. */
  t0: number;
  /** Mean of ln(t − t0). */
  mu: number;
  /** Standard deviation of ln(t − t0). */
  sigma: number;
  /** Direction the arc starts in, radians. */
  thetaS: number;
  /** Direction it ends in. */
  thetaE: number;
}

export interface RunModel {
  /** Lognormal components of one pen-down run. */
  components: LognormalStroke[];
  origin: Point;
  start: number;
  end: number;
  /** Sample times of the original trace, so variants stay index-aligned. */
  times: number[];
  /** The original samples, kept for the correspondence the renderer needs. */
  traced: Point[];
}

export interface SignatureModel {
  runs: RunModel[];
  width: number;
  height: number;
  penRadius: number;
}

/** Abramowitz & Stegun 7.1.26 — plenty for a direction that spans a few degrees. */
const erf = (x: number): number => {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return sign * y;
};

/** Φ, the standard normal CDF. */
const normalCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

/** One lognormal's contribution to speed at time t. */
export const lognormal = (stroke: LognormalStroke, t: number): number => {
  const dt = t - stroke.t0;
  if (dt <= 1e-6) return 0;
  const u = Math.log(dt) - stroke.mu;
  return (
    (1 / (stroke.sigma * Math.sqrt(2 * Math.PI) * dt)) *
    Math.exp(-(u * u) / (2 * stroke.sigma * stroke.sigma))
  );
};

/** Where the arc points at time t: θs early, θe late, Φ-shaped in between. */
const direction = (stroke: LognormalStroke, t: number): number => {
  const dt = t - stroke.t0;
  if (dt <= 1e-6) return stroke.thetaS;
  return (
    stroke.thetaS +
    (stroke.thetaE - stroke.thetaS) * normalCdf((Math.log(dt) - stroke.mu) / stroke.sigma)
  );
};

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Positions on a uniform time grid, sampled from the original trace. */
const resampleInTime = (samples: TimedPoint[], dt: number): TimedPoint[] => {
  const start = samples[0]!.t;
  const end = samples[samples.length - 1]!.t;
  const out: TimedPoint[] = [];
  let cursor = 0;

  for (let t = start; t <= end + 1e-9; t += dt) {
    while (cursor < samples.length - 2 && samples[cursor + 1]!.t < t) cursor += 1;
    const a = samples[cursor]!;
    const b = samples[Math.min(cursor + 1, samples.length - 1)]!;
    const span = b.t - a.t;
    const r = span < 1e-9 ? 0 : Math.min(1, Math.max(0, (t - a.t) / span));
    out.push({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, t });
  }
  return out;
};

const smoothSeries = (values: number[], half: number): number[] =>
  values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k]!;
      n += 1;
    }
    return sum / n;
  });

/**
 * Estimate a lognormal's shape from one velocity bump.
 *
 * The trick that keeps this cheap and stable: for a *known* onset t0,
 * substitute u = ln(t − t0). Then
 *
 *   v(t)·(t − t0) = D / (σ√(2π)) · exp( −(u − μ)² / (2σ²) )
 *
 * — an ordinary Gaussian in u, whose μ and σ are just the weighted mean and
 * spread of u. So only t0 needs searching, over a one-dimensional grid, scoring
 * each candidate by how well the resulting lognormal reproduces the bump. No
 * gradient descent, no initial-guess sensitivity, and it degrades gracefully:
 * a bump that is not lognormal at all simply scores badly everywhere.
 */
const fitBump = (
  times: number[],
  speeds: number[],
  from: number,
  to: number,
  dt: number,
): LognormalStroke | null => {
  const tFirst = times[from]!;
  const tLast = times[to]!;
  const span = tLast - tFirst;
  if (span <= dt) return null;

  let area = 0;
  for (let i = from; i <= to; i++) area += Math.max(0, speeds[i]!) * dt;
  if (area <= 1e-6) return null;

  let best: LognormalStroke | null = null;
  let bestError = Number.POSITIVE_INFINITY;

  // t0 sits at or before the bump's onset; how far before is what we search.
  for (let k = 1; k <= 32; k++) {
    const t0 = tFirst - span * (k / 32) * 1.4 - dt * 0.5;

    let wSum = 0;
    let wu = 0;
    for (let i = from; i <= to; i++) {
      const d = times[i]! - t0;
      if (d <= 1e-6) continue;
      const w = Math.max(0, speeds[i]!) * d;
      wSum += w;
      wu += w * Math.log(d);
    }
    if (wSum <= 1e-9) continue;
    const mu = wu / wSum;

    let wvar = 0;
    for (let i = from; i <= to; i++) {
      const d = times[i]! - t0;
      if (d <= 1e-6) continue;
      const w = Math.max(0, speeds[i]!) * d;
      const c = Math.log(d) - mu;
      wvar += w * c * c;
    }
    const sigma = Math.min(0.85, Math.max(0.06, Math.sqrt(wvar / wSum)));

    // Solve the amplitude that best explains the bump for this shape.
    const shape: LognormalStroke = { D: 1, t0, mu, sigma, thetaS: 0, thetaE: 0 };
    let num = 0;
    let den = 0;
    for (let i = from; i <= to; i++) {
      const base = lognormal(shape, times[i]!);
      num += base * Math.max(0, speeds[i]!);
      den += base * base;
    }
    if (den <= 1e-12) continue;
    const D = num / den;
    if (!Number.isFinite(D) || D <= 1e-6) continue;

    let error = 0;
    for (let i = from; i <= to; i++) {
      const residual = D * lognormal(shape, times[i]!) - Math.max(0, speeds[i]!);
      error += residual * residual;
    }
    if (error < bestError) {
      bestError = error;
      best = { D, t0, mu, sigma, thetaS: 0, thetaE: 0 };
    }
  }

  return best;
};

/**
 * Pull the lognormal components out of a speed profile, largest first.
 *
 * Fitting each segment of the profile independently does not work, and the
 * reason is the model's own physics: lognormals have long tails, so at any
 * instant several commands are still contributing. Fit them side by side and
 * every component is credited with speed its neighbours already supplied, the
 * amplitudes come out inflated, and the reconstructed pen sails off the page.
 *
 * The standard remedy is to extract them one at a time against the residual:
 * take the tallest remaining peak, fit a lognormal to the bump around it,
 * subtract that lognormal from the *whole* profile, repeat. Each component then
 * accounts only for what its predecessors left unexplained, which is what
 * superposition actually means.
 */
const extractComponents = (
  times: number[],
  speeds: number[],
  dt: number,
  limit: number,
): LognormalStroke[] => {
  const residual = speeds.map((v) => Math.max(0, v));
  const peak = Math.max(...residual);
  if (peak <= 1e-6) return [];

  const found: LognormalStroke[] = [];

  for (let iteration = 0; iteration < limit; iteration++) {
    let m = 0;
    for (let i = 1; i < residual.length; i++) if (residual[i]! > residual[m]!) m = i;
    const height = residual[m]!;
    if (height < peak * 0.02) break;

    // The bump around the peak: walk out while the residual keeps falling.
    let left = m;
    while (left > 0 && residual[left - 1]! <= residual[left]! && residual[left]! > height * 0.03) {
      left -= 1;
    }
    let right = m;
    while (
      right < residual.length - 1 &&
      residual[right + 1]! <= residual[right]! &&
      residual[right]! > height * 0.03
    ) {
      right += 1;
    }
    if (right - left < 2) {
      residual[m] = 0;
      continue;
    }

    const stroke = fitBump(times, residual, left, right, dt);
    if (!stroke) {
      for (let i = left; i <= right; i++) residual[i] = 0;
      continue;
    }

    for (let i = 0; i < residual.length; i++) {
      residual[i] = Math.max(0, residual[i]! - stroke.D * lognormal(stroke, times[i]!));
    }
    found.push(stroke);
  }

  return found.sort((a, b) => a.t0 + Math.exp(a.mu) - (b.t0 + Math.exp(b.mu)));
};

/**
 * Solve every component's direction and amplitude at once.
 *
 * With the shapes (t0, μ, σ) fixed, the model velocity is *linear* in the
 * per-stroke vector c_i = D_i·(cos φ_i, sin φ_i):
 *
 *   V(t_k) = Σ_i Λ_i(t_k) · c_i
 *
 * so the c_i that best reproduces the traced velocity is an ordinary least
 * squares solve — small, dense, and global. Doing it globally is what stops the
 * overlap between neighbouring commands from being counted twice, and it is why
 * the reconstruction tracks the real pen instead of drifting away from it.
 */
const solveDirections = (
  components: LognormalStroke[],
  times: number[],
  velocity: Array<{ x: number; y: number }>,
): void => {
  const n = components.length;
  if (n === 0) return;

  // Basis: each component's lognormal sampled on the grid.
  const basis = components.map((stroke) => times.map((t) => lognormal(stroke, t)));

  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const bx = new Array<number>(n).fill(0);
  const by = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const bi = basis[i]!;
    for (let j = i; j < n; j++) {
      const bj = basis[j]!;
      let sum = 0;
      for (let k = 0; k < times.length; k++) sum += bi[k]! * bj[k]!;
      A[i]![j] = sum;
      A[j]![i] = sum;
    }
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < times.length; k++) {
      sx += bi[k]! * velocity[k]!.x;
      sy += bi[k]! * velocity[k]!.y;
    }
    bx[i] = sx;
    by[i] = sy;
  }

  // Ridge term: neighbouring commands overlap heavily, so the normal equations
  // are close to singular. A whisper of regularisation keeps the solve honest.
  let trace = 0;
  for (let i = 0; i < n; i++) trace += A[i]![i]!;
  const ridge = Math.max(1e-9, (trace / n) * 1e-5);
  for (let i = 0; i < n; i++) A[i]![i] = A[i]![i]! + ridge;

  // Gaussian elimination with partial pivoting, two right-hand sides.
  const M = A.map((row, i) => [...row, bx[i]!, by[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) continue;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];

    const diagonal = M[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]! / diagonal;
      if (factor === 0) continue;
      for (let c = col; c <= n + 1; c++) M[r]![c] = M[r]![c]! - factor * M[col]![c]!;
    }
  }

  for (let i = 0; i < n; i++) {
    const diagonal = M[i]![i]!;
    if (Math.abs(diagonal) < 1e-12) continue;
    const cx = M[i]![n]! / diagonal;
    const cy = M[i]![n + 1]! / diagonal;
    const magnitude = Math.hypot(cx, cy);
    const stroke = components[i]!;
    if (magnitude < 1e-9) {
      stroke.D = 0;
      continue;
    }
    stroke.D = magnitude;
    stroke.thetaS = Math.atan2(cy, cx);
    stroke.thetaE = stroke.thetaS;
  }
};

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Restore each command's curvature.
 *
 * The least-squares solve gives every stroke one mean direction, which draws it
 * as a straight dash. A real ballistic movement sweeps: the direction rotates
 * from θs to θe across the stroke. Recovering that from the trace — the heading
 * early in the stroke against the heading late in it — and re-centring it on the
 * solved mean keeps the fit the solve found while putting the loops back.
 */
const restoreArcs = (
  components: LognormalStroke[],
  times: number[],
  headings: number[],
): void => {
  for (const stroke of components) {
    const centre = stroke.t0 + Math.exp(stroke.mu - stroke.sigma * stroke.sigma);

    let earlyX = 0;
    let earlyY = 0;
    let lateX = 0;
    let lateY = 0;
    for (let k = 0; k < times.length; k++) {
      const w = lognormal(stroke, times[k]!);
      if (w <= 1e-9) continue;
      const h = headings[k]!;
      if (times[k]! <= centre) {
        earlyX += w * Math.cos(h);
        earlyY += w * Math.sin(h);
      } else {
        lateX += w * Math.cos(h);
        lateY += w * Math.sin(h);
      }
    }
    if (Math.hypot(earlyX, earlyY) < 1e-9 || Math.hypot(lateX, lateY) < 1e-9) continue;

    const turn = wrapAngle(Math.atan2(lateY, lateX) - Math.atan2(earlyY, earlyX));
    // A hand does not swing half a turn inside one command.
    const bounded = Math.max(-2.2, Math.min(2.2, turn));
    const mean = stroke.thetaS;
    stroke.thetaS = mean - bounded / 2;
    stroke.thetaE = mean + bounded / 2;
  }
};

/**
 * Decompose one pen-down run into lognormal strokes.
 *
 * Two stages, in this order for a reason: the speed profile is scalar and fits
 * robustly on its own, and once the shapes are known the directions become a
 * linear problem that can be solved globally rather than guessed per stroke.
 */
export const fitRun = (samples: TimedPoint[], dt: number): RunModel | null => {
  if (samples.length < 6) return null;

  const grid = resampleInTime(samples, dt);
  if (grid.length < 6) return null;

  const times = grid.map((p) => p.t);

  // Central-difference velocity of the traced pen.
  const velocity = grid.map((_, i) => {
    const a = grid[Math.max(0, i - 1)]!;
    const b = grid[Math.min(grid.length - 1, i + 1)]!;
    const span = (Math.min(grid.length - 1, i + 1) - Math.max(0, i - 1)) * dt;
    return { x: (b.x - a.x) / span, y: (b.y - a.y) / span };
  });
  const rawSpeed = velocity.map((v) => Math.hypot(v.x, v.y));
  const speeds = smoothSeries(rawSpeed, 2);
  const headings = velocity.map((v) => Math.atan2(v.y, v.x));

  // How many commands to allow. The Kinematic Theory puts rapid handwriting at
  // roughly one ballistic command per 25-40ms, and a signature with a dozen
  // loops genuinely needs dozens: capping too low does not simplify the model,
  // it makes it wrong, because the residual left unexplained is exactly the
  // detail that distinguishes this signature from any other. Extraction stops
  // on its own once the residual is flat, so the cap only guards the tail.
  const duration = times[times.length - 1]! - times[0]!;
  const limit = Math.min(160, Math.max(4, Math.round(duration / 0.028)));

  const components = extractComponents(times, speeds, dt, limit);
  if (components.length === 0) return null;

  solveDirections(components, times, velocity);
  const kept = components.filter((c) => c.D > 1e-6);
  if (kept.length === 0) return null;
  restoreArcs(kept, times, headings);

  return {
    components: kept,
    origin: { x: samples[0]!.x, y: samples[0]!.y },
    start: samples[0]!.t,
    end: samples[samples.length - 1]!.t,
    times: samples.map((s) => s.t),
    traced: samples.map((s) => ({ x: s.x, y: s.y })),
  };
};

/** Fit every pen-down run of a trajectory. */
export const fitSignature = (trajectory: Trajectory, dt = 0.006): SignatureModel | null => {
  const runs: RunModel[] = [];
  for (const stroke of trajectory.strokes) {
    const run = fitRun(stroke.samples, dt);
    if (run) runs.push(run);
  }
  if (runs.length === 0) return null;
  return {
    runs,
    width: trajectory.width,
    height: trajectory.height,
    penRadius: trajectory.penRadius,
  };
};

/**
 * Integrate the model back into a trajectory, then read it at the trace's own
 * sample times so model and trace stay index-aligned.
 */
export const reconstructRun = (run: RunModel, dt = 0.002): Point[] => {
  const grid: Point[] = [];
  const gridTimes: number[] = [];

  let x = 0;
  let y = 0;

  // Start early enough to catch strokes whose onset precedes the first sample.
  // Integrating from zero and re-anchoring afterwards keeps whatever the pen
  // had already travelled before the first traced sample out of the origin.
  const earliest = Math.min(run.start, ...run.components.map((s) => s.t0 + 1e-4));

  for (let t = earliest; t <= run.end + dt; t += dt) {
    gridTimes.push(t);
    grid.push({ x, y });

    let vx = 0;
    let vy = 0;
    for (const stroke of run.components) {
      const speed = stroke.D * lognormal(stroke, t);
      if (speed <= 0) continue;
      const phi = direction(stroke, t);
      vx += speed * Math.cos(phi);
      vy += speed * Math.sin(phi);
    }
    x += vx * dt;
    y += vy * dt;
  }

  const readAt = (t: number): Point => {
    let i = 0;
    while (i < gridTimes.length - 2 && gridTimes[i + 1]! < t) i += 1;
    const a = grid[i]!;
    const b = grid[Math.min(i + 1, grid.length - 1)]!;
    const ta = gridTimes[i]!;
    const tb = gridTimes[Math.min(i + 1, gridTimes.length - 1)]!;
    const span = tb - ta;
    const r = span < 1e-9 ? 0 : Math.min(1, Math.max(0, (t - ta) / span));
    return { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r };
  };

  // Anchor the curve so that at the first traced instant the pen is exactly
  // where the trace says it was.
  const anchor = readAt(run.start);
  const offsetX = run.origin.x - anchor.x;
  const offsetY = run.origin.y - anchor.y;
  for (const p of grid) {
    p.x += offsetX;
    p.y += offsetY;
  }

  // Sample the integrated curve at the trace's timestamps.
  const out: Point[] = [];
  let cursor = 0;
  for (const t of run.times) {
    while (cursor < gridTimes.length - 2 && gridTimes[cursor + 1]! < t) cursor += 1;
    const a = grid[cursor]!;
    const b = grid[Math.min(cursor + 1, grid.length - 1)]!;
    const ta = gridTimes[cursor]!;
    const tb = gridTimes[Math.min(cursor + 1, gridTimes.length - 1)]!;
    const span = tb - ta;
    const r = span < 1e-9 ? 0 : Math.min(1, Math.max(0, (t - ta) / span));
    out.push({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r });
  }
  return out;
};

/**
 * A smooth pseudo-random field over stroke index, derived from a seed.
 *
 * Independent noise per stroke would jitter: one letter thrown left, its
 * neighbour right, which no hand does. Real variation drifts — a slant that
 * builds across the word, a run of letters written a little larger. Summing two
 * slow sinusoids with seeded phase and amplitude gives that, and gives it
 * deterministically.
 */
const smoothField = (seed: string, count: number): number[] => {
  const digest = createHash('sha256').update(seed).digest();
  const unit = (i: number) => (digest[i % digest.length]! / 255) * 2 - 1;
  const positive = (i: number) => digest[i % digest.length]! / 255;

  /**
   * Fast enough to be local, smooth enough to look like a hand.
   *
   * The frequencies here used to be under two cycles across the whole
   * signature. That produces variation that is essentially global — a slant, a
   * scale, a slow drift — and global is precisely what the rest of the pipeline
   * removes: the cutout is trimmed to its ink, then fitted into its zone, and
   * both steps normalise away exactly a translation and a scale. Measured, the
   * model produced 3.15% displacement and 0.49% survived to the page.
   *
   * A few cycles across the mark makes neighbouring commands differ from one
   * another, which is what survives normalisation and what reads as a hand that
   * wrote the same name again rather than a copy nudged sideways.
   *
   * There is a ceiling above this, and it is sharp. Pushed to six cycles and
   * beyond, adjacent commands pull in opposite directions and the warp tears
   * the letterforms apart: loops fragment, strokes break into pieces, and the
   * result is not a signature signed differently but a signature damaged. This
   * range is the widest that leaves the mark intact.
   */
  const a1 = unit(0);
  const a2 = unit(1) * 0.6;
  const f1 = 0.35 + positive(2) * 0.9;
  const f2 = 1.1 + positive(3) * 1.4;
  const p1 = positive(4) * Math.PI * 2;
  const p2 = positive(5) * Math.PI * 2;

  /**
   * A per-command term on top, uncorrelated with its neighbours.
   *
   * Real handwriting is not perfectly smooth: one loop comes out fat, the next
   * one clips, a stroke overshoots. That irregularity is what "un peu mal
   * faite" means, and no sum of low-frequency sinusoids will produce it. Kept
   * small: at a third of the budget it stopped reading as an unsteady hand and
   * started reading as a scan with pieces missing.
   */
  const jitter = createHash('sha256').update(`${seed}:jitter`).digest();

  return Array.from({ length: count }, (_, i) => {
    const u = count <= 1 ? 0.5 : i / (count - 1);
    const wave =
      a1 * Math.sin(u * f1 * Math.PI * 2 + p1) + a2 * Math.sin(u * f2 * Math.PI * 2 + p2);
    const local = ((jitter[i % jitter.length]! / 255) * 2 - 1) * 0.12;
    return Math.max(-1, Math.min(1, (wave + local) / 1.5));
  });
};

/**
 * How far each parameter is allowed to move.
 *
 * These are the ranges that read as "the same person, another day". Pushed
 * further the signature stops being the same one; pulled in, the variants stop
 * being distinguishable. D and θ carry most of the visible change — how far a
 * movement reached and where it aimed — while μ and σ retime the overlap
 * between neighbouring strokes, which is what makes the letterforms reorganise
 * rather than merely shift.
 */
export interface PerturbationRange {
  /** Fractional change in stroke amplitude. */
  amplitude: number;
  /** Absolute shift in μ, in log-seconds. */
  timing: number;
  /** Fractional change in σ. */
  spread: number;
  /** Absolute change in arc direction, radians. */
  angle: number;
  /** Whole-signature slant, radians. */
  slant: number;
  /** Whole-signature size. */
  size: number;
}

/**
 * The default spread: one hand signing the same name on another document.
 *
 * `slant` and `size` are small and stay small — not out of caution, but because
 * they are wasted. The cutout is trimmed to its ink and then fitted into its
 * zone, so a global scale is normalised away entirely and a global slant nearly
 * so. Spending the budget there produced variants that measured as different
 * and looked identical. What survives is per-command change: how far each
 * movement carried, where it aimed, and how it overlapped its neighbour.
 */
export const DEFAULT_RANGE: PerturbationRange = {
  amplitude: 0.075,
  timing: 0.055,
  spread: 0.11,
  angle: 0.05,
  slant: 0.022,
  size: 0.03,
};

/**
 * Produce a variant of the model: same person, same signature, another signing.
 *
 * Every component is perturbed along the smooth fields, so neighbouring strokes
 * drift together. The whole-signature slant and size are applied on top, which
 * is what actually separates two signatures at a glance before you look closely.
 */
export const perturb = (
  model: SignatureModel,
  seed: string,
  range: PerturbationRange = DEFAULT_RANGE,
): SignatureModel => {
  const total = model.runs.reduce((n, run) => n + run.components.length, 0);

  const fAmp = smoothField(`${seed}:amplitude`, total);
  const fMu = smoothField(`${seed}:timing`, total);
  const fSigma = smoothField(`${seed}:spread`, total);
  const fThetaS = smoothField(`${seed}:theta-start`, total);
  const fThetaE = smoothField(`${seed}:theta-end`, total);

  const global = createHash('sha256').update(`${seed}:global`).digest();
  const gUnit = (i: number) => (global[i % global.length]! / 255) * 2 - 1;
  const slant = gUnit(0) * range.slant;
  const size = 1 + gUnit(1) * range.size;

  let k = 0;
  const runs = model.runs.map((run) => ({
    ...run,
    components: run.components.map((stroke) => {
      const i = k++;
      return {
        D: stroke.D * (1 + fAmp[i]! * range.amplitude) * size,
        t0: stroke.t0,
        mu: stroke.mu + fMu[i]! * range.timing,
        sigma: Math.min(0.9, Math.max(0.05, stroke.sigma * (1 + fSigma[i]! * range.spread))),
        thetaS: stroke.thetaS + fThetaS[i]! * range.angle + slant,
        thetaE: stroke.thetaE + fThetaE[i]! * range.angle + slant,
      };
    }),
  }));

  return { ...model, runs };
};

/**
 * How well the model explains the trace, as a fraction of the mark's height.
 *
 * A trajectory that could not be decomposed — a scanned mess, a mask that
 * skeletonised into confetti — produces a reconstruction that wanders off. That
 * has to be detected rather than rendered, so the caller can fall back instead
 * of stamping something that is no longer the signer's signature.
 */
export const reconstructionError = (model: SignatureModel): number => {
  let sum = 0;
  let n = 0;
  for (const run of model.runs) {
    const rebuilt = reconstructRun(run);
    for (let i = 0; i < run.traced.length; i++) {
      sum += distance(run.traced[i]!, rebuilt[i] ?? run.traced[i]!);
      n += 1;
    }
  }
  return n === 0 ? Number.POSITIVE_INFINITY : sum / n / Math.max(1, model.height);
};
