import type { QualityLevel } from '@scansign/shared';
import {
  describeExposure,
  describeSharpness,
  describeSheet,
  type PhotoQuality,
} from '../lib/quality';

/**
 * The sensors, as a row of coloured chips: green is good, amber is usable,
 * red says retake. A chip per thing the signer can act on — hold still, find
 * light, get the whole sheet in — and nothing they cannot.
 */

const TONE: Record<QualityLevel | 'neutral', string> = {
  ok: 'bg-emerald-500/90 text-white',
  warn: 'bg-amber-400/90 text-ink-900',
  bad: 'bg-red-500/90 text-white',
  neutral: 'bg-white/20 text-white',
};

const DOT: Record<QualityLevel | 'neutral', string> = {
  ok: 'bg-white',
  warn: 'bg-ink-900/70',
  bad: 'bg-white',
  neutral: 'bg-white/60',
};

const Chip = ({ level, label }: { level: QualityLevel | 'neutral'; label: string }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold backdrop-blur ${TONE[level]}`}
  >
    <span className={`h-1.5 w-1.5 rounded-full ${DOT[level]}`} />
    {label}
  </span>
);

export const QualityChips = ({
  quality,
  /** Whether the page itself was found and straightened (scanner step). */
  pageFound,
  /** Show the sheet chip: on a page that expects the attestation's sheet. */
  expectSheet = true,
  className = '',
}: {
  quality: PhotoQuality | null;
  pageFound?: boolean;
  expectSheet?: boolean;
  className?: string;
}) => {
  if (!quality) {
    return (
      <div className={`flex flex-wrap gap-1.5 ${className}`}>
        <Chip level="neutral" label="Analyse…" />
      </div>
    );
  }
  const sheetLevel: QualityLevel | 'neutral' = quality.sheet
    ? quality.sheet.fields.every((f) => f.markersFound >= 3)
      ? 'ok'
      : 'warn'
    : 'neutral';
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      <Chip level={quality.sharpness.level} label={describeSharpness(quality.sharpness)} />
      <Chip level={quality.exposure.level} label={describeExposure(quality.exposure)} />
      {pageFound !== undefined && (
        <Chip level={pageFound ? 'ok' : 'warn'} label={pageFound ? 'Page cadrée' : 'Page non détectée'} />
      )}
      {expectSheet && <Chip level={sheetLevel} label={describeSheet(quality.sheet)} />}
    </div>
  );
};
