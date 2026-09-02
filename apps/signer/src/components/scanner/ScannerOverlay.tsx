import type { Corners, ScannerTone } from '../../types/scanner';
import type { FrameSize } from '../../hooks/useDocumentScanner';

/**
 * The contour over the camera.
 *
 * One SVG whose viewBox is the video's own pixel size, with
 * `preserveAspectRatio="xMidYMid slice"` — the exact mapping `object-fit: cover`
 * applies to the <video> underneath. Normalized corners × frame size therefore
 * land on the paper on every screen ratio, portrait or landscape, without any
 * arithmetic on the DOM.
 *
 * Colour moves red → orange → green through a CSS transition on the stroke, so
 * the state changes read as a fade, never a blink. When no page is seen, a
 * dashed guide shows where to put one.
 */
const STROKE: Record<ScannerTone, string> = {
  red: '#ef4444',
  orange: '#f59e0b',
  green: '#22c55e',
};

export const ScannerOverlay = ({
  corners,
  tone,
  frame,
}: {
  corners: Corners | null;
  tone: ScannerTone;
  frame: FrameSize | null;
}) => {
  const w = frame?.width ?? 1080;
  const h = frame?.height ?? 1920;
  const stroke = STROKE[tone];
  const points = corners
    ? [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft]
        .map((p) => `${p.x * w},${p.y * h}`)
        .join(' ')
    : null;
  const dot = Math.max(w, h) * 0.008;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      {points ? (
        <>
          {/* Dim everything but the page. */}
          <path
            d={`M0 0H${w}V${h}H0Z M${points.split(' ').join(' L')}Z`}
            fill="rgba(0,0,0,0.42)"
            fillRule="evenodd"
            style={{ transition: 'fill 0.3s' }}
          />
          <polygon
            points={points}
            fill="none"
            stroke={stroke}
            strokeWidth={4}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ transition: 'stroke 0.3s ease' }}
          />
          {[corners!.topLeft, corners!.topRight, corners!.bottomRight, corners!.bottomLeft].map(
            (p, i) => (
              <circle
                key={i}
                cx={p.x * w}
                cy={p.y * h}
                r={dot}
                fill={stroke}
                stroke="#fff"
                strokeWidth={dot * 0.35}
                style={{ transition: 'fill 0.3s ease' }}
              />
            ),
          )}
        </>
      ) : (
        <rect
          x={w * 0.08}
          y={h * 0.1}
          width={w * 0.84}
          height={h * 0.8}
          rx={w * 0.02}
          fill="none"
          stroke={stroke}
          strokeWidth={3}
          strokeDasharray="14 12"
          vectorEffect="non-scaling-stroke"
          opacity={0.8}
          style={{ transition: 'stroke 0.3s ease' }}
        />
      )}
    </svg>
  );
};
