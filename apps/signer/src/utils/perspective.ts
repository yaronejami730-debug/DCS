import { CORNER_KEYS, type Corners, type Point } from '../types/scanner';

/**
 * Plane geometry on a detected quadrilateral. Pure, unit-agnostic: works on
 * normalized corners as well as on pixels, as long as all four agree.
 */

export const cornerList = (c: Corners): Point[] => CORNER_KEYS.map((k) => c[k]);

/** Shoelace area of the quad, in the corners' own units squared. */
export const quadArea = (c: Corners): number => {
  const p = cornerList(c);
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Side lengths in corner order: top, right, bottom, left. */
export const sideLengths = (c: Corners): [number, number, number, number] => [
  distance(c.topLeft, c.topRight),
  distance(c.topRight, c.bottomRight),
  distance(c.bottomRight, c.bottomLeft),
  distance(c.bottomLeft, c.topLeft),
];

/** Interior angle at each corner, in degrees, in corner order. */
export const cornerAngles = (c: Corners): [number, number, number, number] => {
  const p = cornerList(c);
  const angles = p.map((point, i) => {
    const prev = p[(i + 3) % 4]!;
    const next = p[(i + 1) % 4]!;
    const v1 = { x: prev.x - point.x, y: prev.y - point.y };
    const v2 = { x: next.x - point.x, y: next.y - point.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const n = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
    if (n === 0) return 0;
    return (Math.acos(Math.min(1, Math.max(-1, dot / n))) * 180) / Math.PI;
  });
  return angles as [number, number, number, number];
};

/** Every turn in the same direction, none degenerate. */
export const isConvex = (c: Corners): boolean => {
  const p = cornerList(c);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const o = p[i]!;
    const a = p[(i + 1) % 4]!;
    const b = p[(i + 2) % 4]!;
    const cross = (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

export const boundingBox = (c: Corners) => {
  const p = cornerList(c);
  const xs = p.map((q) => q.x);
  const ys = p.map((q) => q.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
};

/** Corners divided by a frame size → normalized; multiplied → pixels. */
export const scaleCorners = (c: Corners, sx: number, sy: number): Corners => ({
  topLeft: { x: c.topLeft.x * sx, y: c.topLeft.y * sy },
  topRight: { x: c.topRight.x * sx, y: c.topRight.y * sy },
  bottomRight: { x: c.bottomRight.x * sx, y: c.bottomRight.y * sy },
  bottomLeft: { x: c.bottomLeft.x * sx, y: c.bottomLeft.y * sy },
});

/** Largest displacement of any corner between two readings, in the corners' units. */
export const maxCornerDisplacement = (a: Corners, b: Corners): number =>
  Math.max(...CORNER_KEYS.map((k) => distance(a[k], b[k])));

/** Are all four points finite numbers? Guards against a detector returning NaN. */
export const cornersAreFinite = (c: Corners): boolean =>
  cornerList(c).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
