/**
 * Recover a plausible pen trajectory from a static signature image.
 *
 * This is the step that makes a kinematic model possible at all. SynSig2Vec and
 * the Sigma-Lognormal literature it builds on work on *online* signatures —
 * tablet captures where the pen reports (x, y, t) directly. What we hold is the
 * opposite: a photograph of ink already dry on paper, with the movement that
 * produced it thrown away.
 *
 * So we reconstruct it. Not the true movement — that information is genuinely
 * gone — but a trajectory consistent with how a hand produces those shapes:
 *
 *   ink mask -> 1px skeleton -> stroke graph -> pen-plausible ordering
 *            -> uniform resampling -> timing from the one-third power law
 *
 * The last step is the one that carries real content. Arc length alone gives no
 * timing, but human movement obeys a well-established relation between speed
 * and curvature (the "two-thirds power law", Lacquaniti et al.): the pen slows
 * into curves and accelerates out of them, with angular velocity proportional
 * to curvature^(2/3), i.e. tangential speed proportional to curvature^(-1/3).
 * Applying it turns a curve into a timed trajectory whose velocity profile has
 * the bell-shaped bursts the Sigma-Lognormal model is built to describe.
 */

export interface Point {
  x: number;
  y: number;
}

export interface TimedPoint extends Point {
  /** Seconds from the start of the whole signature. */
  t: number;
}

export interface PenStroke {
  /** Pen-down samples, uniform in arc length then timed by curvature. */
  samples: TimedPoint[];
}

export interface Trajectory {
  strokes: PenStroke[];
  width: number;
  height: number;
  /** Median distance from skeleton to ink edge — half the pen's nib width. */
  penRadius: number;
}

/** Ink is anything meaningfully opaque; feathered edges are not skeleton material. */
const INK_ALPHA = 96;

/** 8-neighbourhood, clockwise from north — the Zhang-Suen P2..P9 ordering. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export const inkMask = (
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
): Uint8Array => {
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 3; p < rgba.length; i++, p += 4) {
    mask[i] = rgba[p]! >= INK_ALPHA ? 1 : 0;
  }
  return mask;
};

/**
 * Zhang-Suen thinning: erode the mask to a one-pixel-wide skeleton while
 * preserving connectivity and endpoints.
 *
 * Connectivity is the whole point — the skeleton is about to be read as a
 * graph, and a thinning that breaks a loop invents a pen lift that never
 * happened.
 */
export const thin = (mask: Uint8Array, width: number, height: number): Uint8Array => {
  const img = Uint8Array.from(mask);
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : img[y * width + x]!;

  const doomed: number[] = [];
  let changed = true;
  let guard = 0;

  while (changed && guard++ < 64) {
    changed = false;

    for (const step of [0, 1]) {
      doomed.length = 0;

      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          if (img[y * width + x] !== 1) continue;

          const n = NEIGHBOURS.map(([dx, dy]) => at(x + dx, y + dy));
          const filled = n.reduce((a, b) => a + b, 0);
          if (filled < 2 || filled > 6) continue;

          // Number of 0 -> 1 transitions around the ring. Exactly one means
          // removing this pixel cannot disconnect its neighbourhood.
          let transitions = 0;
          for (let k = 0; k < 8; k++) {
            if (n[k] === 0 && n[(k + 1) % 8] === 1) transitions += 1;
          }
          if (transitions !== 1) continue;

          const [p2, p3, p4, p5, p6, p7, p8, p9] = n as [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          void p3;
          void p5;
          void p7;
          void p9;

          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          doomed.push(y * width + x);
        }
      }

      if (doomed.length > 0) {
        changed = true;
        for (const index of doomed) img[index] = 0;
      }
    }
  }

  return img;
};

/** Half the pen width, estimated as the median distance from skeleton to edge. */
const estimatePenRadius = (
  mask: Uint8Array,
  skeleton: Uint8Array,
  width: number,
  height: number,
): number => {
  const inkCount = mask.reduce<number>((a, b) => a + b, 0);
  const boneCount = skeleton.reduce<number>((a, b) => a + b, 0);
  if (boneCount === 0) return 1;
  // Area / length is the mean width of a ribbon; halve it for a radius.
  return Math.max(0.5, inkCount / boneCount / 2);
};

interface Node {
  index: number;
  x: number;
  y: number;
  degree: number;
}

interface Edge {
  from: number;
  to: number;
  points: Point[];
}

const degreeOf = (
  skeleton: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number => {
  let d = 0;
  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    if (skeleton[ny * width + nx] === 1) d += 1;
  }
  return d;
};

/**
 * Read the skeleton as a graph: nodes where the pen path branches or stops,
 * edges for the smooth runs between them.
 */
const buildGraph = (
  skeleton: Uint8Array,
  width: number,
  height: number,
): { nodes: Map<number, Node>; edges: Edge[] } => {
  const nodes = new Map<number, Node>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (skeleton[index] !== 1) continue;
      const degree = degreeOf(skeleton, width, height, x, y);
      if (degree !== 2) nodes.set(index, { index, x, y, degree });
    }
  }

  const edges: Edge[] = [];
  const walked = new Set<string>();

  const neighboursOf = (index: number): number[] => {
    const x = index % width;
    const y = (index - x) / width;
    const out: number[] = [];
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (skeleton[ny * width + nx] === 1) out.push(ny * width + nx);
    }
    return out;
  };

  for (const node of nodes.values()) {
    for (const first of neighboursOf(node.index)) {
      const key = `${node.index}:${first}`;
      if (walked.has(key)) continue;

      const points: Point[] = [{ x: node.x, y: node.y }];
      let previous = node.index;
      let current = first;

      // Follow the degree-2 chain until the next node.
      for (;;) {
        points.push({ x: current % width, y: Math.floor(current / width) });
        if (nodes.has(current)) break;
        const next = neighboursOf(current).find((n) => n !== previous);
        if (next === undefined) break;
        previous = current;
        current = next;
      }

      walked.add(key);
      walked.add(`${current}:${previous}`);
      if (points.length >= 2) edges.push({ from: node.index, to: current, points });
    }
  }

  // Closed loops carry no node at all — an "o" written in one go. Seed one.
  const covered = new Set<number>();
  for (const edge of edges) {
    for (const p of edge.points) covered.add(p.y * width + p.x);
  }
  for (let index = 0; index < skeleton.length; index++) {
    if (skeleton[index] !== 1 || covered.has(index)) continue;

    const points: Point[] = [];
    let previous = -1;
    let current = index;
    for (;;) {
      points.push({ x: current % width, y: Math.floor(current / width) });
      covered.add(current);
      const next = neighboursOf(current).find((n) => n !== previous && !covered.has(n));
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    if (points.length >= 4) {
      points.push({ ...points[0]! });
      edges.push({ from: index, to: index, points });
    }
  }

  return { nodes, edges };
};

const angleOf = (a: Point, b: Point): number => Math.atan2(b.y - a.y, b.x - a.x);

const angleGap = (a: number, b: number): number => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
};

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Walk the graph the way a pen would.
 *
 * At a junction a hand carries on in roughly the direction it was already
 * going — it does not double back and it does not pick a branch at random. So
 * the traversal is greedy on continuity: of the edges still unwritten, take the
 * one demanding the smallest change of direction. When nothing continues, the
 * pen lifts and lands on the nearest unwritten edge, which ends the stroke.
 *
 * Latin script is written left to right, so both the starting point and the
 * order of disconnected components follow x.
 */
const orderStrokes = (
  nodes: Map<number, Node>,
  edges: Edge[],
  width: number,
): Point[][] => {
  const unused = new Set(edges.keys());
  const byEndpoint = new Map<number, number[]>();
  edges.forEach((edge, i) => {
    for (const end of [edge.from, edge.to]) {
      const list = byEndpoint.get(end);
      if (list) list.push(i);
      else byEndpoint.set(end, [i]);
    }
  });

  const pointOf = (index: number): Point => ({ x: index % width, y: Math.floor(index / width) });

  const strokes: Point[][] = [];

  while (unused.size > 0) {
    // Start each pen-down run at the leftmost free endpoint, preferring a true
    // stroke end (degree 1) over a junction.
    let startEdge = -1;
    let startNode = -1;
    let best = Number.POSITIVE_INFINITY;
    for (const i of unused) {
      const edge = edges[i]!;
      for (const end of [edge.from, edge.to]) {
        const p = pointOf(end);
        const isTip = (nodes.get(end)?.degree ?? 1) === 1;
        const score = p.x - (isTip ? width : 0);
        if (score < best) {
          best = score;
          startEdge = i;
          startNode = end;
        }
      }
    }
    if (startEdge < 0) break;

    let stroke: Point[] = [];
    let node = startNode;
    let edgeIndex: number | undefined = startEdge;
    let heading: number | null = null;

    while (edgeIndex !== undefined) {
      const edge = edges[edgeIndex]!;
      unused.delete(edgeIndex);

      const forward = edge.from === node;
      const pts = forward ? edge.points : [...edge.points].reverse();
      if (stroke.length > 0) stroke.pop();
      stroke.push(...pts);

      const tail = pts[pts.length - 1]!;
      const before = pts[Math.max(0, pts.length - 4)]!;
      heading = angleOf(before, tail);
      node = forward ? edge.to : edge.from;

      // Continue through the junction along the straightest branch.
      let bestTurn = Math.PI * 0.75;
      let next: number | undefined;
      for (const candidate of byEndpoint.get(node) ?? []) {
        if (!unused.has(candidate)) continue;
        const e = edges[candidate]!;
        const head = e.from === node ? e.points : [...e.points].reverse();
        const turn = angleGap(heading, angleOf(head[0]!, head[Math.min(3, head.length - 1)]!));
        if (turn < bestTurn) {
          bestTurn = turn;
          next = candidate;
        }
      }
      edgeIndex = next;
    }

    if (stroke.length >= 3) strokes.push(stroke);
  }

  return strokes;
};

/** Moving average — the skeleton is a staircase and curvature hates staircases. */
const smoothPath = (points: Point[], window: number): Point[] => {
  if (points.length < 3) return points;
  const half = Math.max(1, Math.floor(window / 2));
  return points.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(points.length - 1, i + half); k++) {
      sx += points[k]!.x;
      sy += points[k]!.y;
      n += 1;
    }
    return { x: sx / n, y: sy / n };
  });
};

/** Re-space a polyline so every sample is `step` pixels from the last. */
export const resampleUniform = (points: Point[], step: number): Point[] => {
  if (points.length < 2) return points;
  const out: Point[] = [points[0]!];
  let carry = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segment = distance(a, b);
    if (segment < 1e-9) continue;

    let travelled = step - carry;
    while (travelled <= segment) {
      const r = travelled / segment;
      out.push({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r });
      travelled += step;
    }
    carry = segment - (travelled - step);
  }

  const last = points[points.length - 1]!;
  if (distance(out[out.length - 1]!, last) > step * 0.5) out.push(last);
  return out;
};

/**
 * Menger curvature at each sample: the reciprocal radius of the circle through
 * three consecutive points.
 */
const curvatures = (points: Point[]): number[] => {
  const k: number[] = new Array(points.length).fill(0);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    const ab = distance(a, b);
    const bc = distance(b, c);
    const ca = distance(c, a);
    const denom = ab * bc * ca;
    k[i] = denom < 1e-9 ? 0 : Math.abs(2 * area) / denom;
  }
  if (points.length > 2) {
    k[0] = k[1]!;
    k[points.length - 1] = k[points.length - 2]!;
  }
  return k;
};

/** Mean writing speed in pixels per second, at the scale signatures are captured. */
const MEAN_SPEED = 160;

/**
 * Turn an ordered, uniformly spaced path into a timed trajectory.
 *
 * Speed follows the one-third power law: v = γ·κ^(-1/3), so the pen crawls
 * through tight loops and runs along the straights. κ0 keeps a perfectly
 * straight run from demanding infinite speed.
 */
export const timePath = (points: Point[], startTime: number, step: number): TimedPoint[] => {
  const k = curvatures(points);
  const kFloor = 1 / Math.max(8, step * 24);

  const raw = k.map((value) => Math.pow(value + kFloor, -1 / 3));
  const mean = raw.reduce((a, b) => a + b, 0) / Math.max(1, raw.length);
  const scale = mean > 1e-9 ? MEAN_SPEED / mean : 1;

  const out: TimedPoint[] = [];
  let t = startTime;
  for (let i = 0; i < points.length; i++) {
    out.push({ ...points[i]!, t });
    const speed = Math.min(4 * MEAN_SPEED, Math.max(0.15 * MEAN_SPEED, raw[i]! * scale));
    t += step / speed;
  }
  return out;
};

/** Time the pen spends in the air between two strokes. */
const penUpSeconds = (gap: number): number => 0.06 + Math.min(0.25, gap / 1400);

/** Seconds a whole signature is taken to last, before fitting. See below. */
const TARGET_DURATION = 2.2;

export interface TraceOptions {
  /** Arc-length spacing of the resampled path, in pixels. */
  step?: number;
  /** Drop skeleton fragments shorter than this many pixels — they are specks. */
  minStrokeLength?: number;
}

/**
 * Full trace: RGBA raster in, timed pen trajectory out.
 *
 * Returns null when there is nothing a pen could have written — an empty
 * cutout, or a mask so fragmented that no stroke survives. Callers treat that
 * as "this image cannot be modelled" and fall back rather than guessing.
 */
export const traceSignature = (
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
  options: TraceOptions = {},
): Trajectory | null => {
  const step = options.step ?? 1.5;
  const minLength = options.minStrokeLength ?? Math.max(6, height * 0.06);

  if (width < 8 || height < 8) return null;

  const mask = inkMask(rgba, width, height);
  if (mask.reduce<number>((a, b) => a + b, 0) < 24) return null;

  const skeleton = thin(mask, width, height);
  const penRadius = estimatePenRadius(mask, skeleton, width, height);

  const { nodes, edges } = buildGraph(skeleton, width, height);
  if (edges.length === 0) return null;

  const ordered = orderStrokes(nodes, edges, width);

  const strokes: PenStroke[] = [];
  let clock = 0;
  let previousEnd: Point | null = null;

  for (const raw of ordered) {
    const smoothed = smoothPath(raw, Math.max(3, Math.round(penRadius * 2) | 1));
    const spaced = resampleUniform(smoothed, step);
    const length = (spaced.length - 1) * step;
    if (length < minLength || spaced.length < 4) continue;

    if (previousEnd) clock += penUpSeconds(distance(previousEnd, spaced[0]!));
    const samples = timePath(spaced, clock, step);
    clock = samples[samples.length - 1]!.t;
    previousEnd = spaced[spaced.length - 1]!;
    strokes.push({ samples });
  }

  if (strokes.length === 0) return null;

  /**
   * Normalise the total duration.
   *
   * Only *relative* timing carries information — the pixel scale of a cutout is
   * an accident of how close the phone was held, and letting it set the clock
   * would make σ mean something different for every photo. Pinning the whole
   * signature to a fixed duration keeps the fitted parameters in the range the
   * Kinematic Theory literature reports, so one set of perturbation bounds
   * behaves the same on a 300px crop and a 1200px one.
   */
  const span = clock;
  if (span > 1e-6) {
    const factor = TARGET_DURATION / span;
    for (const stroke of strokes) {
      for (const sample of stroke.samples) sample.t *= factor;
    }
  }

  return { strokes, width, height, penRadius };
};
