import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  moveNormalizedRect,
  resizeNormalizedRect,
  type NormalizedRect,
  type RectCorner,
} from '@scansign/shared';

/**
 * Frame a region of the captured photo.
 *
 * Everything is kept in normalized 0..1 coordinates relative to the photo, so
 * the selection means the same thing to the server as it does on screen, at any
 * window size. The photo shown here has already had its EXIF orientation baked
 * in by the backend, so what the user frames is exactly what gets cropped — and
 * the geometry helpers are the same unit-tested ones the iPhone app calls.
 *
 * Pointer Events, not mouse or touch events.
 *
 * One code path covers a finger, a stylus and a mouse, and — the part that
 * actually matters — `setPointerCapture` keeps the drag alive when the pointer
 * leaves the image, which happens constantly when you drag a corner towards the
 * edge. Without capture the box stops following the finger halfway and the user
 * has to grab it again. `touch-action: none` is what stops the browser from
 * reading the same gesture as a page scroll.
 */

/** Visible size of a corner marker, in CSS pixels. */
const HANDLE_SIZE = 24;
/**
 * Grab radius around a corner, by pointer.
 *
 * A fingertip needs ~44px of slack; a mouse cursor is a point and giving it
 * the same halo made small boxes ungrabbable — everywhere inside was "near a
 * corner", so every drag resized instead of moving. The radius follows what
 * is actually pointing.
 */
const HANDLE_HIT_TOUCH = 46;
const HANDLE_HIT_MOUSE = 14;

export interface RegionSelectorProps {
  photoUrl: string;
  photoWidth: number;
  photoHeight: number;
  value: NormalizedRect | null;
  onChange: (rect: NormalizedRect) => void;
  tint?: string;
  /** Seeds the first box when `value` is null. */
  defaultRect?: NormalizedRect;
}

type Mode = 'move' | 'draw' | RectCorner;

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

export const RegionSelector = ({
  photoUrl,
  photoWidth,
  photoHeight,
  value,
  onChange,
  tint = '#2f5fe0',
  defaultRect = { x: 0.15, y: 0.3, width: 0.7, height: 0.4 },
}: RegionSelectorProps) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  /**
   * Available width, measured rather than assumed.
   *
   * The selector sits in a column whose width depends on the viewport, so the
   * photo box is derived from what the parent actually granted. A ResizeObserver
   * keeps it correct through a phone rotation, which changes the width without
   * remounting anything.
   */
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

  // Fit the photo inside the available area without distortion. Constraining
  // the height matters for portrait captures, which would otherwise run off the
  // bottom of the screen and put the lower handles out of reach.
  const { boxWidth, boxHeight } = useMemo(() => {
    const maxWidth = available > 0 ? available : 360;
    const maxHeight = typeof window !== 'undefined' ? window.innerHeight * 0.46 : 400;
    const scale = Math.min(maxWidth / photoWidth, maxHeight / photoHeight);
    return {
      boxWidth: Math.max(1, Math.round(photoWidth * scale)),
      boxHeight: Math.max(1, Math.round(photoHeight * scale)),
    };
  }, [available, photoWidth, photoHeight]);

  const [rect, setRect] = useState<NormalizedRect>(value ?? defaultRect);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  /** What the cursor is over, when NOT dragging — drives the mouse cursor. */
  const [hover, setHover] = useState<Mode | null>(null);

  // --- everything the gesture handlers read, held in refs -------------------
  const rectRef = useRef(rect);
  const startRef = useRef<{ rect: NormalizedRect; mode: Mode; x: number; y: number } | null>(null);
  const onChangeRef = useRef(onChange);
  const draggingRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  /**
   * Coalesce drag updates to the display's own rhythm.
   *
   * Pointer events arrive at up to 120Hz; re-rendering React for each one made
   * dragging on a large scan visibly stutter, since every update also redraws
   * the live crop preview. One rAF per frame keeps the box glued to the finger
   * at exactly the rate the screen can show it.
   */
  const frame = useRef<number | null>(null);
  const pendingRect = useRef<NormalizedRect | null>(null);
  const apply = useCallback((next: NormalizedRect) => {
    rectRef.current = next;
    pendingRect.current = next;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!pendingRect.current) return;
      setRect(pendingRect.current);
      onChangeRef.current(pendingRect.current);
    });
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  // Adopt a selection supplied by the parent — a restored step, or a region the
  // backend suggested. Ignored mid-drag so it cannot fight the finger.
  useEffect(() => {
    if (!value || draggingRef.current) return;
    const r = rectRef.current;
    if (
      Math.abs(r.x - value.x) < 1e-6 &&
      Math.abs(r.y - value.y) < 1e-6 &&
      Math.abs(r.width - value.width) < 1e-6 &&
      Math.abs(r.height - value.height) < 1e-6
    ) {
      return;
    }
    rectRef.current = value;
    setRect(value);
  }, [value]);

  // Publish the seeded box once, so the "Continuer" button is live immediately.
  useEffect(() => {
    if (!value) onChangeRef.current(rectRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Pointer position in 0..1 photo space. */
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

  /** What a pointer at this spot would grab: a corner, the box, or fresh canvas. */
  const pick = (
    point: { x: number; y: number; width: number; height: number },
    pointerType: string,
  ): Mode => {
    const current = rectRef.current;
    const radius = pointerType === 'touch' ? HANDLE_HIT_TOUCH : HANDLE_HIT_MOUSE;
    const corners: Array<{ mode: RectCorner; x: number; y: number }> = [
      { mode: 'nw', x: current.x, y: current.y },
      { mode: 'ne', x: current.x + current.width, y: current.y },
      { mode: 'sw', x: current.x, y: current.y + current.height },
      { mode: 'se', x: current.x + current.width, y: current.y + current.height },
    ];

    let picked: Mode = 'draw';
    let closest = Number.POSITIVE_INFINITY;
    for (const corner of corners) {
      const distance = Math.hypot(
        (point.x - corner.x) * point.width,
        (point.y - corner.y) * point.height,
      );
      if (distance < radius && distance < closest) {
        closest = distance;
        picked = corner.mode;
      }
    }

    if (picked === 'draw') {
      const inside =
        point.x >= current.x &&
        point.x <= current.x + current.width &&
        point.y >= current.y &&
        point.y <= current.y + current.height;
      if (inside) picked = 'move';
    }
    return picked;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = pointAt(event);
    if (!point) return;

    // Capture, so the drag survives the pointer leaving the image — which is
    // exactly what happens when a corner is pulled towards the edge.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();

    const picked = pick(point, event.pointerType);
    startRef.current = { rect: rectRef.current, mode: picked, x: point.x, y: point.y };
    draggingRef.current = true;
    setDragging(true);
    setMode(picked);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) {
      // Not dragging: track what is under the mouse, so the cursor says what
      // a press would do — grab, resize, or draw. The corner markers cannot
      // carry their own CSS cursors, sitting as they do in a pointer-events:
      // none overlay.
      const point = pointAt(event);
      if (point && event.pointerType !== 'touch') setHover(pick(point, event.pointerType));
      return;
    }
    const point = pointAt(event);
    if (!point) return;
    event.preventDefault();

    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const minWidth = Math.max(HANDLE_SIZE * 2, 60) / point.width;
    const minHeight = Math.max(HANDLE_SIZE * 2, 60) / point.height;
    const base = start.rect;

    let next: NormalizedRect;
    if (start.mode === 'move') {
      next = moveNormalizedRect(base, dx, dy);
    } else if (start.mode === 'draw') {
      const cx = clamp01(point.x);
      const cy = clamp01(point.y);
      const x = Math.min(start.x, cx);
      const y = Math.min(start.y, cy);
      next = {
        x,
        y,
        width: Math.min(Math.max(Math.abs(cx - start.x), minWidth), 1 - x),
        height: Math.min(Math.max(Math.abs(cy - start.y), minHeight), 1 - y),
      };
    } else {
      // Opposite corner pinned, minimum size enforced, never inverted.
      // Unit-tested in @scansign/shared.
      next = resizeNormalizedRect(base, start.mode, dx, dy, minWidth, minHeight);
    }

    apply(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    startRef.current = null;
    draggingRef.current = false;
    setDragging(false);
    setMode(null);
  };

  const left = rect.x * boxWidth;
  const top = rect.y * boxHeight;
  const width = rect.width * boxWidth;
  const height = rect.height * boxHeight;

  // Live crop preview: the finger sits on top of the mark being framed, so the
  // result has to be shown somewhere else.
  const previewWidth = Math.min(available > 0 ? available : 320, 250);
  const imageWidth = previewWidth / Math.max(rect.width, 0.001);
  const imageHeight = imageWidth * (photoHeight / photoWidth);
  const previewHeight = Math.max(48, Math.round(rect.height * imageHeight));

  const cornerStyles: Record<RectCorner, React.CSSProperties> = {
    nw: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2, cursor: 'nwse-resize' },
    ne: { right: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2, cursor: 'nesw-resize' },
    sw: { left: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2, cursor: 'nesw-resize' },
    se: { right: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2, cursor: 'nwse-resize' },
  };

  return (
    <div ref={wrapRef}>
      <div
        ref={surfaceRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        className="relative mx-auto touch-none overflow-hidden rounded-xl bg-black select-none"
        style={{
          width: boxWidth,
          height: boxHeight,
          cursor: dragging
            ? mode === 'move'
              ? 'grabbing'
              : 'crosshair'
            : hover === 'move'
              ? 'grab'
              : hover === 'nw' || hover === 'se'
                ? 'nwse-resize'
                : hover === 'ne' || hover === 'sw'
                  ? 'nesw-resize'
                  : 'crosshair',
        }}
      >
        <img
          src={photoUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ objectFit: 'fill' }}
        />

        {/* Dim everything outside the selection. */}
        <div
          className="pointer-events-none absolute bg-ink-900/55"
          style={{ left: 0, top: 0, right: 0, height: top }}
        />
        <div
          className="pointer-events-none absolute bg-ink-900/55"
          style={{ left: 0, top: top + height, right: 0, bottom: 0 }}
        />
        <div
          className="pointer-events-none absolute bg-ink-900/55"
          style={{ left: 0, top, width: left, height }}
        />
        <div
          className="pointer-events-none absolute bg-ink-900/55"
          style={{ left: left + width, top, right: 0, height }}
        />

        <div
          className="pointer-events-none absolute rounded-sm"
          style={{
            left,
            top,
            width,
            height,
            borderColor: tint,
            borderWidth: dragging ? 3 : 2,
            borderStyle: 'solid',
          }}
        >
          <span className="absolute bottom-0 top-0 w-px bg-white/35" style={{ left: '33.33%' }} />
          <span className="absolute bottom-0 top-0 w-px bg-white/35" style={{ left: '66.66%' }} />
          <span className="absolute left-0 right-0 h-px bg-white/35" style={{ top: '33.33%' }} />
          <span className="absolute left-0 right-0 h-px bg-white/35" style={{ top: '66.66%' }} />

          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span
              key={corner}
              className="absolute rounded-full border-[3px] border-white transition-transform"
              style={{
                ...cornerStyles[corner],
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                backgroundColor: tint,
                transform: mode === corner ? 'scale(1.3)' : undefined,
              }}
            />
          ))}
        </div>

        {!dragging && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2.5 flex justify-center">
            <span className="rounded-full bg-ink-900/80 px-3 py-1.5 text-xs font-medium text-white">
              Glissez le cadre · tirez les coins
            </span>
          </div>
        )}
      </div>

      <div className="mt-3.5 flex flex-col items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-ink-400">
          Aperçu de la découpe
        </span>
        <div
          className="relative overflow-hidden rounded-lg bg-white"
          style={{
            width: previewWidth,
            height: previewHeight,
            border: `2px solid ${tint}`,
          }}
        >
          <img
            src={photoUrl}
            alt=""
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={{
              width: imageWidth,
              height: imageHeight,
              left: -rect.x * imageWidth,
              top: -rect.y * imageHeight,
              objectFit: 'fill',
            }}
          />
        </div>
      </div>
    </div>
  );
};
