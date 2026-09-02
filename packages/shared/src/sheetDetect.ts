import {
  CAPTURE_SHEET_LAYOUTS,
  SHEET_FIELD_MARKER,
  SHEET_PAGE,
  SHEET_PAGE_MARKER,
  sheetFieldMarkerCentres,
  sheetPageMarkerCentres,
  type CaptureSheetLayout,
  type SheetField,
  type SheetPoint,
} from './captureSheet.js';
import type { NormalizedRect } from './geometry.js';
import type { ZoneType } from './status.js';

/**
 * Read a photographed capture sheet back into field rectangles — the pure core.
 *
 * Takes a greyscale buffer and nothing else, so the same code runs on the API
 * (fed by sharp) and in the signer's browser (fed by a canvas), and a sheet the
 * phone says is "well framed" is one the server will read the same way.
 *
 * The sheet (see captureSheet.ts) prints four large squares in the page corners
 * and four small ones around every field. We find the squares, fit the page with
 * a homography from the four corner squares, and project each field's box — so
 * a selector opens already sitting on the signature, and each box arrives
 * labelled with what it is and which documents it is for.
 *
 * Thresholding and connected components, not a vision model: solid black
 * squares on white paper are the most detectable thing there is. Everything
 * returned is a suggestion a person can still drag.
 *
 * Steps:
 *   threshold against the paper level -> label connected components
 *   -> keep the solid, square ones
 *   -> pick the four that frame the largest page-shaped quadrilateral
 *   -> for each of the four possible orientations, fit a homography and
 *      count how many field markers land where predicted; keep the best
 *   -> project every field, snapping to its own markers when they are found
 */

/** Width the caller should downscale to before calling — enough for 9pt markers, cheap enough for a phone. */
export const SHEET_DETECT_WORK_WIDTH = 1100;

/** A candidate square must be at least this wide, in work pixels. */
const MIN_MARKER_PX = 5;
/** ...and at most this share of the image width — beyond it, it is a shadow or the sheet. */
const MAX_MARKER_RATIO = 0.09;
/** Share of the bounding box a solid square fills. Ink strokes fill far less. */
const MIN_FILL = 0.72;
/** Page markers must frame at least this share of the image. */
const MIN_PAGE_AREA_RATIO = 0.2;
/** At least this share of a layout's field markers must be found to accept it. */
const MIN_FIELD_MARKER_HIT = 0.5;

export interface SheetFieldDetection {
  id: string;
  type: ZoneType;
  targets: readonly string[];
  title: string;
  /** Screen wording of the box, e.g. "Étude · Devis · Absence de tampon". */
  label: string;
  /** The writing area, normalized to the photo, ready for the selector. */
  rect: NormalizedRect;
  /** How many of the field's own four markers were seen (0..4). */
  markersFound: number;
  /** Share of the box's interior that is ink, 0..1. */
  inkShare: number;
  /** Someone wrote in this box. Empty boxes are not offered for capture. */
  filled: boolean;
}

/** Below this share of dark pixels, a box is considered untouched. */
export const SHEET_FIELD_FILLED_MIN_INK = 0.0015;

/**
 * How much of a box's interior is ink — the box shrunk a little further so a
 * printed border caught by a loose fit is not counted as writing.
 */
const inkShareInside = (
  grey: Uint8Array,
  width: number,
  height: number,
  rect: NormalizedRect,
  threshold: number,
): number => {
  const insetX = rect.width * 0.06;
  const insetY = rect.height * 0.08;
  const x0 = Math.max(0, Math.round((rect.x + insetX) * width));
  const y0 = Math.max(0, Math.round((rect.y + insetY) * height));
  const x1 = Math.min(width, Math.round((rect.x + rect.width - insetX) * width));
  const y1 = Math.min(height, Math.round((rect.y + rect.height - insetY) * height));
  if (x1 <= x0 || y1 <= y0) return 0;
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) if (grey[row + x]! < threshold) ink += 1;
  }
  return ink / ((x1 - x0) * (y1 - y0));
}

export interface SheetDetection {
  layoutId: string;
  /** Degrees the sheet is turned in the photo: 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270;
  /** The four page-marker centres in the photo, normalized: TL, TR, BR, BL of the SHEET. */
  pageQuad: [SheetPoint, SheetPoint, SheetPoint, SheetPoint];
  fields: SheetFieldDetection[];
}

interface Blob {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  mass: number;
  cx: number;
  cy: number;
  size: number;
}

/** Value below which a pixel counts as ink, derived from the paper itself. */
const inkThreshold = (grey: Uint8Array): number => {
  const histogram = new Uint32Array(256);
  for (const value of grey) histogram[value]! += 1;
  const target = grey.length * 0.8;
  let seen = 0;
  let paper = 255;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen >= target) {
      paper = v;
      break;
    }
  }
  // Markers are solid black: bite deeper than the ink detector does, so a
  // grey pencil stroke is not mistaken for one.
  return Math.max(20, Math.round(paper * 0.5));
};

/** Iterative flood fill over the mask; returns every component's box and mass. */
const labelBlobs = (mask: Uint8Array, width: number, height: number): Blob[] => {
  const seen = new Uint8Array(mask.length);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  const maxSide = width * MAX_MARKER_RATIO;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let mass = 0;
    let sumX = 0;
    let sumY = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      mass += 1;
      sumX += x;
      sumY += y;

      // 4-connectivity: a marker is solid, it does not need diagonal joins,
      // and diagonal joins are what glue a marker to a nearby pen stroke.
      if (x > 0 && mask[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && mask[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && mask[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && mask[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw > maxSide * 1.5 || bh > maxSide * 1.5) continue; // the sheet edge, a shadow
    blobs.push({
      minX,
      minY,
      maxX,
      maxY,
      mass,
      cx: sumX / mass,
      cy: sumY / mass,
      size: (bw + bh) / 2,
    });
  }
  return blobs;
};

/** Solid, square-ish, plausible size: what a printed marker looks like. */
const isSquare = (blob: Blob, width: number): boolean => {
  const bw = blob.maxX - blob.minX + 1;
  const bh = blob.maxY - blob.minY + 1;
  if (bw < MIN_MARKER_PX || bh < MIN_MARKER_PX) return false;
  if (bw > width * MAX_MARKER_RATIO || bh > width * MAX_MARKER_RATIO) return false;
  const aspect = bw / bh;
  if (aspect < 0.6 || aspect > 1.66) return false;
  return blob.mass / (bw * bh) >= MIN_FILL;
};

type Quad = [SheetPoint, SheetPoint, SheetPoint, SheetPoint];

const cross = (o: SheetPoint, a: SheetPoint, b: SheetPoint) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Shoelace area of a polygon given in order. */
const quadArea = (q: Quad): number => {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
};

const isConvex = (q: Quad): boolean => {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i]!, q[(i + 1) % 4]!, q[(i + 2) % 4]!);
    if (Math.abs(c) < 1e-6) return false;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

/**
 * Among the square blobs, the four that frame the page: for every group of
 * similarly sized squares, take the extreme one in each diagonal direction
 * and keep the largest convex quadrilateral that covers enough of the image.
 */
const findPageQuad = (squares: Blob[], width: number, height: number): Quad | null => {
  let best: { quad: Quad; area: number } | null = null;
  const sorted = [...squares].sort((a, b) => a.size - b.size);

  for (const anchor of sorted) {
    const group = sorted.filter((s) => s.size >= anchor.size * 0.7 && s.size <= anchor.size * 1.45);
    if (group.length < 4) continue;

    const tl = group.reduce((m, s) => (s.cx + s.cy < m.cx + m.cy ? s : m));
    const tr = group.reduce((m, s) => (s.cx - s.cy > m.cx - m.cy ? s : m));
    const br = group.reduce((m, s) => (s.cx + s.cy > m.cx + m.cy ? s : m));
    const bl = group.reduce((m, s) => (s.cy - s.cx > m.cy - m.cx ? s : m));
    const picked = new Set([tl, tr, br, bl]);
    if (picked.size < 4) continue;

    const quad: Quad = [
      { x: tl.cx, y: tl.cy },
      { x: tr.cx, y: tr.cy },
      { x: br.cx, y: br.cy },
      { x: bl.cx, y: bl.cy },
    ];
    if (!isConvex(quad)) continue;
    const area = quadArea(quad);
    if (area < width * height * MIN_PAGE_AREA_RATIO) continue;

    // The page markers are the biggest squares on the sheet; a quad framed by
    // squares of a size that many larger squares exist alongside is a field.
    const larger = squares.filter((s) => s.size > anchor.size * 1.6).length;
    if (larger >= 4) continue;

    if (!best || area > best.area) best = { quad, area };
  }
  return best?.quad ?? null;
};

// --- homography ------------------------------------------------------------

type Matrix3 = [number, number, number, number, number, number, number, number, number];

/** Solve Ax = b by Gaussian elimination with partial pivoting. */
const solve = (a: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
};

/** Homography mapping `from[i]` onto `to[i]`, four point pairs. */
const homography = (from: Quad, to: Quad): Matrix3 | null => {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(a, b);
  if (!h) return null;
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
};

const project = (h: Matrix3, p: SheetPoint): SheetPoint => {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
};

/** Rotate the sheet's TL,TR,BR,BL so image TL,TR,BR,BL match a turned sheet. */
const rotateQuad = (q: Quad, turns: number): Quad => {
  const out = [...q] as Quad;
  for (let i = 0; i < turns; i++) out.push(out.shift()!);
  return out;
};

const ROTATIONS: Array<SheetDetection['rotation']> = [0, 90, 180, 270];

const nearest = (
  squares: Blob[],
  at: SheetPoint,
  expectedSize: number,
): Blob | null => {
  let best: Blob | null = null;
  let bestDist = Infinity;
  const radius = Math.max(expectedSize * 1.6, 6);
  for (const s of squares) {
    if (s.size < expectedSize * 0.45 || s.size > expectedSize * 2.2) continue;
    const d = Math.hypot(s.cx - at.x, s.cy - at.y);
    if (d < radius && d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
};

const bbox = (points: SheetPoint[]): { minX: number; minY: number; maxX: number; maxY: number } => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
});

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/**
 * Project one field into the photo.
 *
 * Its own markers, when seen, beat the global fit: the page is never perfectly
 * flat, and a box that snaps to the squares actually around it lands on the
 * ink even when the corner fit is a few pixels off across the page. The crop
 * is then inset from the marker centres by the printed gap, so no marker is
 * ever part of it.
 */
const projectField = (
  field: SheetField,
  h: Matrix3,
  squares: Blob[],
  scale: number,
  width: number,
  height: number,
): SheetFieldDetection => {
  const markerPx = SHEET_FIELD_MARKER.size * scale;
  const found: SheetPoint[] = [];
  for (const centre of sheetFieldMarkerCentres(field)) {
    const predicted = project(h, centre);
    const hit = nearest(squares, predicted, markerPx);
    if (hit) found.push({ x: hit.cx, y: hit.cy });
  }

  let box: { minX: number; minY: number; maxX: number; maxY: number };
  if (found.length === 4) {
    const b = bbox(found);
    const inset = (SHEET_FIELD_MARKER.gap + SHEET_FIELD_MARKER.size / 2) * scale;
    box = { minX: b.minX + inset, minY: b.minY + inset, maxX: b.maxX - inset, maxY: b.maxY - inset };
  } else {
    const { x, y, width: w, height: hgt } = field.rect;
    const corners = [
      project(h, { x, y }),
      project(h, { x: x + w, y }),
      project(h, { x: x + w, y: y + hgt }),
      project(h, { x, y: y + hgt }),
    ];
    box = bbox(corners);
  }

  // A hair inside the printed border, which must never be part of the crop.
  const safety = 3 * scale;
  const x0 = clamp01((box.minX + safety) / width);
  const y0 = clamp01((box.minY + safety) / height);
  const x1 = clamp01((box.maxX - safety) / width);
  const y1 = clamp01((box.maxY - safety) / height);

  return {
    id: field.id,
    type: field.type,
    targets: field.targets,
    title: field.title,
    label: field.label,
    rect: { x: x0, y: y0, width: Math.max(x1 - x0, 0.01), height: Math.max(y1 - y0, 0.01) },
    markersFound: found.length,
    inkShare: 0,
    filled: false,
  };
};

/**
 * Fit one layout at every orientation; return the fit whose field markers are
 * most often where predicted, or null when no orientation reaches the bar.
 */
const fitLayout = (
  layout: CaptureSheetLayout,
  pageQuad: Quad,
  squares: Blob[],
  width: number,
  height: number,
): SheetDetection | null => {
  const sheetCorners = sheetPageMarkerCentres();
  const pageArea = quadArea(pageQuad);
  const scale = Math.sqrt(pageArea / ((SHEET_PAGE.width - 2 * SHEET_PAGE_MARKER.inset) * (SHEET_PAGE.height - 2 * SHEET_PAGE_MARKER.inset)));
  const markerPx = SHEET_FIELD_MARKER.size * scale;

  let best: { detection: SheetDetection; hits: number } | null = null;
  for (const [turns, rotation] of ROTATIONS.entries()) {
    const from = rotateQuad(sheetCorners, turns);
    const h = homography(from, pageQuad);
    if (!h) continue;

    let hits = 0;
    let total = 0;
    for (const field of layout.fields) {
      for (const centre of sheetFieldMarkerCentres(field)) {
        total += 1;
        if (nearest(squares, project(h, centre), markerPx)) hits += 1;
      }
    }
    if (total === 0 || hits / total < MIN_FIELD_MARKER_HIT) continue;
    if (best && hits <= best.hits) continue;

    const fields = layout.fields.map((f) => projectField(f, h, squares, scale, width, height));
    // Report the SHEET's corners as they sit in the photo, in sheet order.
    const quadInSheetOrder = rotateQuad(pageQuad, (4 - turns) % 4);
    best = {
      hits,
      detection: {
        layoutId: layout.id,
        rotation,
        pageQuad: quadInSheetOrder.map((p) => ({ x: p.x / width, y: p.y / height })) as Quad,
        fields,
      },
    };
  }
  return best?.detection ?? null;
};


/**
 * Detect the sheet in a greyscale image (row-major, one byte per pixel).
 * Returns null when the picture is not a sheet — which is not an error.
 */
export const detectSheetInGrey = (
  grey: Uint8Array,
  width: number,
  height: number,
): SheetDetection | null => {
  const threshold = inkThreshold(grey);

  const mask = new Uint8Array(width * height);
  let inkCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (grey[i]! < threshold) {
      mask[i] = 1;
      inkCount += 1;
    }
  }
  // Nothing dark enough to be a marker, or a frame that is mostly dark.
  if (inkCount < 40 || inkCount > mask.length * 0.5) return null;

  const squares = labelBlobs(mask, width, height).filter((b) => isSquare(b, width));
  if (squares.length < 4) return null;

  const pageQuad = findPageQuad(squares, width, height);
  if (!pageQuad) return null;

  let best: SheetDetection | null = null;
  for (const layout of CAPTURE_SHEET_LAYOUTS) {
    const fit = fitLayout(layout, pageQuad, squares, width, height);
    const score = (d: SheetDetection) => d.fields.reduce((n, f) => n + f.markersFound, 0);
    if (fit && (!best || score(fit) > score(best))) best = fit;
  }
  if (!best) return null;

  // Ink is judged with a gentler threshold than the markers: a pen stroke is
  // grey in a photo where a printed square is black.
  const inkLevel = Math.max(threshold, Math.round(inkThreshold(grey) * 1.5));
  for (const field of best.fields) {
    field.inkShare = inkShareInside(grey, width, height, field.rect, inkLevel);
    field.filled = field.inkShare >= SHEET_FIELD_FILLED_MIN_INK;
  }
  return best;
};
