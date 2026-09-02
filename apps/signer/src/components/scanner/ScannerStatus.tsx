import type { ScannerStatus as Status, ScannerTone } from '../../types/scanner';
import { STATUS_MESSAGE, STATUS_TONE } from '../../utils/documentValidation';

/** The one line the signer reads: what to do next, in the contour's colour. */
const PILL: Record<ScannerTone, string> = {
  red: 'bg-red-500/90 text-white',
  orange: 'bg-amber-400/95 text-ink-900',
  green: 'bg-emerald-500/95 text-white',
};

export const ScannerStatus = ({ status }: { status: Status }) => {
  const tone = STATUS_TONE[status];
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-[calc(env(safe-area-inset-top)+64px)]">
      <span
        className={`rounded-full px-4 py-2 text-[15px] font-semibold shadow-lg backdrop-blur transition-colors duration-300 ${PILL[tone]}`}
        role="status"
        aria-live="polite"
      >
        {STATUS_MESSAGE[status]}
      </span>
    </div>
  );
};
