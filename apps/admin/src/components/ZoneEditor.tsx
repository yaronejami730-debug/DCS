import { useRef, useState } from 'react';
import type { NormalizedRect, ZoneType } from '@scansign/shared';
import { zoneLabel } from '../lib/zoneLabel';

export interface EditorZone {
  /** Local id; the server assigns real ids on save. */
  key: string;
  page: number;
  type: ZoneType;
  rect: NormalizedRect;
  /** Capture-sheet box this zone is filled from; see zoneLabel. */
  sheetField?: string | null;
}

const TONE: Record<ZoneType, { box: string; label: string }> = {
  signature: { box: 'border-brand-600 bg-brand-500/15', label: 'bg-brand-600' },
  stamp: { box: 'border-emerald-600 bg-emerald-500/15', label: 'bg-emerald-600' },
  mention: { box: 'border-amber-600 bg-amber-500/15', label: 'bg-amber-600' },
  signature_stamp: { box: 'border-purple-600 bg-purple-500/15', label: 'bg-purple-600' },
  date: { box: 'border-rose-600 bg-rose-500/15', label: 'bg-rose-600' },
  quote_date: { box: 'border-orange-600 bg-orange-500/15', label: 'bg-orange-600' },
  invoice_date: { box: 'border-orange-600 bg-orange-500/15', label: 'bg-orange-600' },
  free_text: { box: 'border-cyan-700 bg-cyan-600/15', label: 'bg-cyan-700' },
  checkbox: { box: 'border-slate-600 bg-slate-500/15', label: 'bg-slate-600' },
};

const MIN_SIZE = 0.02;

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/**
 * Draggable/resizable zone overlay, laid on top of the rendered PDF page.
 *
 * All geometry is kept in normalized 0..1 units, so the zone the operator draws
 * at 900px wide is the same zone whatever the screen, the zoom or the DPI.
 * The conversion to PDF points happens on the server at generation time.
 */
/**
 * Marks that come in one size: a company stamp is a die, and a zone for it is
 * placed with a click, not drawn — nobody should have to guess how big a stamp
 * is. The size is the operator's own measurement of the ideal box on their
 * documents: 0.185 × 0.059 of an A4 page, i.e. about 39 × 17.5 mm, the
 * rectangular company stamp. On another format the stamp's natural-size cap
 * keeps it sane.
 */
const FIXED_SIZE: Partial<Record<ZoneType, { width: number; height: number }>> = {
  stamp: { width: 0.185, height: 0.059 },
};

export const isFixedSize = (type: ZoneType): boolean => Boolean(FIXED_SIZE[type]);

export const ZoneEditor = ({
  width,
  height,
  page,
  zones,
  drawing,
  onDrawn,
  onChange,
  onSelect,
  selectedKey,
}: {
  width: number;
  height: number;
  page: number;
  zones: EditorZone[];
  /** When set, the next drag creates a zone of this type. */
  drawing: ZoneType | null;
  onDrawn: (rect: NormalizedRect, type: ZoneType) => void;
  onChange: (key: string, rect: NormalizedRect) => void;
  onSelect: (key: string | null) => void;
  selectedKey: string | null;
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<NormalizedRect | null>(null);

  const pointToNormalized = (clientX: number, clientY: number) => {
    const box = surfaceRef.current!.getBoundingClientRect();
    return { x: clamp01((clientX - box.left) / box.width), y: clamp01((clientY - box.top) / box.height) };
  };

  const startDraw = (event: React.PointerEvent) => {
    if (!drawing) {
      onSelect(null);
      return;
    }
    event.preventDefault();
    const origin = pointToNormalized(event.clientX, event.clientY);
    const fixed = FIXED_SIZE[drawing];
    if (fixed) {
      // One click: the zone lands centred on the pointer, at its standard size.
      onDrawn(
        {
          x: clamp01(Math.min(Math.max(origin.x - fixed.width / 2, 0), 1 - fixed.width)),
          y: clamp01(Math.min(Math.max(origin.y - fixed.height / 2, 0), 1 - fixed.height)),
          width: fixed.width,
          height: fixed.height,
        },
        drawing,
      );
      return;
    }
    const surface = surfaceRef.current!;
    surface.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const current = pointToNormalized(e.clientX, e.clientY);
      setPreview({
        x: Math.min(origin.x, current.x),
        y: Math.min(origin.y, current.y),
        width: Math.abs(current.x - origin.x),
        height: Math.abs(current.y - origin.y),
      });
    };

    const finish = (e: PointerEvent) => {
      surface.releasePointerCapture(event.pointerId);
      surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', finish);
      const current = pointToNormalized(e.clientX, e.clientY);
      const rect: NormalizedRect = {
        x: Math.min(origin.x, current.x),
        y: Math.min(origin.y, current.y),
        width: Math.abs(current.x - origin.x),
        height: Math.abs(current.y - origin.y),
      };
      setPreview(null);
      // A click without a drag should not leave an invisible zone behind.
      if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) onDrawn(rect, drawing);
    };

    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', finish);
  };

  const startTransform = (
    event: React.PointerEvent,
    zone: EditorZone,
    mode: 'move' | 'resize',
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(zone.key);
    const start = pointToNormalized(event.clientX, event.clientY);
    const initial = zone.rect;
    const surface = surfaceRef.current!;
    surface.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const now = pointToNormalized(e.clientX, e.clientY);
      const dx = now.x - start.x;
      const dy = now.y - start.y;

      const next: NormalizedRect =
        mode === 'move'
          ? {
              x: clamp01(Math.min(initial.x + dx, 1 - initial.width)),
              y: clamp01(Math.min(initial.y + dy, 1 - initial.height)),
              width: initial.width,
              height: initial.height,
            }
          : {
              x: initial.x,
              y: initial.y,
              width: Math.min(Math.max(initial.width + dx, MIN_SIZE), 1 - initial.x),
              height: Math.min(Math.max(initial.height + dy, MIN_SIZE), 1 - initial.y),
            };
      onChange(zone.key, next);
    };

    const finish = () => {
      surface.releasePointerCapture(event.pointerId);
      surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', finish);
    };

    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', finish);
  };

  const visible = zones.filter((z) => z.page === page);

  return (
    <div
      ref={surfaceRef}
      onPointerDown={startDraw}
      className={`absolute inset-0 ${drawing ? 'cursor-crosshair' : 'cursor-default'}`}
      style={{ width, height }}
    >
      {visible.map((zone) => {
        const tone = TONE[zone.type];
        const selected = zone.key === selectedKey;
        return (
          <div
            key={zone.key}
            onPointerDown={(e) => startTransform(e, zone, 'move')}
            className={`absolute border-2 ${tone.box} ${
              selected ? 'ring-2 ring-offset-1 ring-ink-800' : ''
            } cursor-move`}
            style={{
              left: `${zone.rect.x * 100}%`,
              top: `${zone.rect.y * 100}%`,
              width: `${zone.rect.width * 100}%`,
              height: `${zone.rect.height * 100}%`,
            }}
          >
            <span
              className={`absolute -top-5 left-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${tone.label}`}
            >
              {zoneLabel(zone, zones)}
            </span>
            {!isFixedSize(zone.type) && (
              <span
                onPointerDown={(e) => startTransform(e, zone, 'resize')}
                className="absolute -right-1.5 -bottom-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm bg-white ring-2 ring-ink-800"
              />
            )}
          </div>
        );
      })}

      {preview && preview.width > 0 && (
        <div
          className={`absolute border-2 border-dashed ${TONE[drawing ?? 'signature'].box}`}
          style={{
            left: `${preview.x * 100}%`,
            top: `${preview.y * 100}%`,
            width: `${preview.width * 100}%`,
            height: `${preview.height * 100}%`,
          }}
        />
      )}
    </div>
  );
};
