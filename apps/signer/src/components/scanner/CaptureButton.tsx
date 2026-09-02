/**
 * The shutter. Big, round, thumb-sized, bottom centre.
 *
 * Disabled is visibly disabled — faded ring, no fill — and inert. Enabled is a
 * white disc in a green ring. The `disabled` attribute stops the tap in the
 * DOM; the hook's own check stops it in logic, so a tap that lands the very
 * instant the page slips out of frame captures nothing.
 */
export const CaptureButton = ({
  enabled,
  busy,
  onCapture,
}: {
  enabled: boolean;
  busy: boolean;
  onCapture: () => void;
}) => (
  <button
    type="button"
    aria-label={busy ? 'Capture en cours' : enabled ? 'Prendre la photo' : 'Cadrez le document pour capturer'}
    disabled={!enabled || busy}
    onClick={onCapture}
    className={`relative flex h-[76px] w-[76px] items-center justify-center rounded-full transition duration-300 ${
      enabled ? 'ring-4 ring-emerald-400 active:scale-95' : 'ring-4 ring-white/30 opacity-45'
    } disabled:cursor-not-allowed`}
  >
    <span
      className={`block h-[60px] w-[60px] rounded-full transition-colors duration-300 ${
        busy ? 'animate-pulse bg-emerald-200' : enabled ? 'bg-white' : 'bg-white/60'
      }`}
    />
  </button>
);
