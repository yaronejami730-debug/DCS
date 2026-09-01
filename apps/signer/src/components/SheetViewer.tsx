import { PdfViewer } from './PdfViewer';

/**
 * The document, full screen, on the phone it will be signed from.
 *
 * A tap on a document used to open the raw storage URL in a new tab — which on
 * a phone means losing the signing page, and on some Androids means a download
 * prompt instead of a view. This keeps the technician exactly where they are:
 * the PDF renders in place, and the two actions that matter — print it, share
 * it to whoever has the printer — sit above it.
 *
 * Loaded lazily from the landing page: pdf.js is bigger than the rest of the
 * app, and a technician who only came to send photos back never pays for it.
 */
export const SheetViewer = ({
  url,
  filename,
  onClose,
  onPrint,
}: {
  url: string;
  filename: string;
  onClose: () => void;
  /** Fired when the print/share action is taken — presence reporting. */
  onPrint?: () => void;
}) => {
  const share = async () => {
    onPrint?.();
    // The native share sheet reaches WhatsApp, mail, a nearby printer — the
    // channels this document actually travels by. Absent (desktop, old
    // browsers), the new-tab fallback covers printing.
    try {
      if (navigator.share) {
        await navigator.share({ title: filename, url });
        return;
      }
    } catch {
      /* user closed the share sheet — not an error */
    }
    window.open(url, '_blank', 'noopener');
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900/60">
      <div className="mx-auto flex h-full w-full max-w-[720px] flex-col bg-ink-50">
        <div className="flex items-center gap-2 border-b border-ink-200 bg-white px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink-900">
            {filename}
          </p>
          <button
            type="button"
            onClick={() => void share()}
            className="shrink-0 rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-semibold text-white active:bg-brand-600"
          >
            Imprimer / Partager
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="shrink-0 rounded-lg p-2 text-ink-400 active:bg-ink-100"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <PdfViewer url={url} maxWidth={680} />
        </div>
      </div>
    </div>
  );
};

export default SheetViewer;
