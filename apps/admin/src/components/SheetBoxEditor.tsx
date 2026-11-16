import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  moveNormalizedRect,
  resizeNormalizedRect,
  type NormalizedRect,
  type RectCorner,
} from '@scansign/shared';

/**
 * Every detected box at once, each with its own four handles.
 *
 * « Ajuster à la main » on a recognised sheet is not about framing a new
 * region: the boxes are already there, and the operator only nudges or widens
 * the ones the detector got slightly short or slightly off. So all of them are
 * editable together — drag a corner to resize, drag the inside to move — and
 * each change is reported the moment it is made.
 *
 * Same Pointer Events approach as RegionSelector (one code path for finger,
 * stylus and mouse, with pointer capture so a drag survives leaving the image).
 */
const HANDLE = 18;
const HIT_TOUCH = 40;
const HIT_MOUSE = 14;

export interface EditableBox {
  id: string;
  rect: NormalizedRect;
  tint: string;
  label: string;
  muted?: boolean;
}

type Grab = { id: string; mode: 'move' | RectCorner };

export const SheetBoxEditor = ({
  photoUrl,
  photoWidth,
  photoHeight,
  boxes,
  onChange,
}: {
  photoUrl: string;
  photoWidth: number;
  photoHeight: number;
  boxes: EditableBox[];
  onChange: (id: string, rect: NormalizedRect) => void;
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);

  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const measure = () => setAvailable(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { boxWidth, boxHeight } = useMemo(() => {
    const maxWidth = available > 0 ? available : 360;
    const maxHeight = typeof window !== 'undefined' ? window.innerHeight * 0.72 : 600;
    const scale = Math.min(maxWidth / photoWidth, maxHeight / photoHeight);
    return {
      boxWidth: Math.max(1, Math.round(photoWidth * scale)),
      boxHeight: Math.max(1, Math.round(photoHeight * scale)),
    };
  }, [available, photoWidth, photoHeight]);

  const boxesRef = useRef(boxes);
  useEffect(() => {
    boxesRef.current = boxes;
  });
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const [active, setActive] = useState<string | null>(null);
  const grab = useRef<{ target: Grab; base: NormalizedRect; x: number; y: number } | null>(null);

  const pointAt = (event: { clientX: number; clientY: number }) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
      width: bounds.width,
      height: bounds.height,
    };
  };

  /** The nearest corner of ANY box, else the smallest box under the pointer. */
  const pick = (
    point: { x: number; y: number; width: number; height: number },
    pointerType: string,
  ): Grab | null => {
    const radius = pointerType === 'touch' ? HIT_TOUCH : HIT_MOUSE;
    let best: Grab | null = null;
    let closest = Number.POSITIVE_INFINITY;
    for (const box of boxesRef.current) {
      const r = box.rect;
      const corners: Array<[RectCorner, number, number]> = [
        ['nw', r.x, r.y],
        ['ne', r.x + r.width, r.y],
        ['sw', r.x, r.y + r.height],
        ['se', r.x + r.width, r.y + r.height],
      ];
      for (const [mode, cx, cy] of corners) {
        const d = Math.hypot((point.x - cx) * point.width, (point.y - cy) * point.height);
        if (d < radius && d < closest) {
          closest = d;
          best = { id: box.id, mode };
        }
      }
    }
    if (best) return best;

    let smallest = Number.POSITIVE_INFINITY;
    for (const box of boxesRef.current) {
      const r = box.rect;
      const inside =
        point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
      const area = r.width * r.height;
      if (inside && area < smallest) {
        smallest = area;
        best = { id: box.id, mode: 'move' };
      }
    }
    return best;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = pointAt(event);
    if (!point) return;
    const target = pick(point, event.pointerType);
    if (!target) return;
    const base = boxesRef.current.find((b) => b.id === target.id)?.rect;
    if (!base) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    grab.current = { target, base, x: point.x, y: point.y };
    setActive(target.id);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    const point = pointAt(event);
    if (!point) return;
    event.preventDefault();
    const dx = point.x - g.x;
    const dy = point.y - g.y;
    const minWidth = Math.max(HANDLE * 2, 40) / point.width;
    const minHeight = Math.max(HANDLE * 2, 30) / point.height;
    const next =
      g.target.mode === 'move'
        ? moveNormalizedRect(g.base, dx, dy)
        : resizeNormalizedRect(g.base, g.target.mode, dx, dy, minWidth, minHeight);
    onChangeRef.current(g.target.id, next);
  };

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!grab.current) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    grab.current = null;
    setActive(null);
  };

  const corners: Array<[RectCorner, React.CSSProperties]> = [
    ['nw', { left: -HANDLE / 2, top: -HANDLE / 2 }],
    ['ne', { right: -HANDLE / 2, top: -HANDLE / 2 }],
    ['sw', { left: -HANDLE / 2, bottom: -HANDLE / 2 }],
    ['se', { right: -HANDLE / 2, bottom: -HANDLE / 2 }],
  ];

  return (
    <div ref={wrapRef}>
      <div
        ref={surfaceRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        className="relative mx-auto touch-none select-none overflow-hidden rounded-xl bg-black"
        style={{ width: boxWidth, height: boxHeight, cursor: 'crosshair' }}
      >
        <img
          src={photoUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ objectFit: 'fill' }}
        />
        {boxes.map((box) => (
          <div
            key={box.id}
            className="pointer-events-none absolute rounded-sm"
            style={{
              left: box.rect.x * boxWidth,
              top: box.rect.y * boxHeight,
              width: box.rect.width * boxWidth,
              height: box.rect.height * boxHeight,
              border: `${active === box.id ? 3 : 2}px ${box.muted ? 'dashed' : 'solid'} ${box.tint}`,
              opacity: box.muted ? 0.7 : 1,
              zIndex: active === box.id ? 2 : 1,
            }}
          >
            <span
              className="absolute left-0 top-0 -translate-y-full whitespace-nowrap rounded-t px-1.5 py-0.5 text-[10px] font-semibold text-white"
              style={{ backgroundColor: box.tint }}
            >
              {box.label}
            </span>
            {corners.map(([corner, style]) => (
              <span
                key={corner}
                className="absolute rounded-full border-2 border-white"
                style={{ ...style, width: HANDLE, height: HANDLE, backgroundColor: box.tint }}
              />
            ))}
          </div>
        ))}
      </div>
      <p className="mt-2 text-center text-xs text-ink-400">
        Tirez un coin pour agrandir une case · glissez l’intérieur pour la déplacer
      </p>
    </div>
  );
};
