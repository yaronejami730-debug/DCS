import { useEffect, useRef, useState } from 'react';
import { useDocumentScanner } from '../../hooks/useDocumentScanner';
import type { ScannedDocument } from '../../types/scanner';
import { STATUS_TONE } from '../../utils/documentValidation';
import { Button } from '../ui';
import { CaptureButton } from './CaptureButton';
import { ScannerOverlay } from './ScannerOverlay';
import { ScannerStatus } from './ScannerStatus';

/**
 * Full-screen document scanner.
 *
 * Camera behind, contour over it, one message on top, one button below. The
 * page is captured only when the hook says the frame is ready — framed, still,
 * sharp, lit — and it says so only after the stability window. The component
 * owns nothing clever: the hook detects and decides, the utilities validate,
 * this file lays them out and handles the three permission stories.
 *
 * Permission stories, because a black rectangle explains nothing:
 *   granted      → the scanner;
 *   prompt/denied→ what to allow and, when the browser remembers a refusal,
 *                  where to lift it (Safari and Chrome keep it per site);
 *   unsupported  → no camera through the browser (HTTP on a LAN, an old
 *                  browser) → offer the device's own camera through a file input.
 */
export const DocumentScanner = ({
  onScanned,
  onClose,
  onFallback,
  title = 'Scanner la page signée',
}: {
  onScanned: (doc: ScannedDocument) => void;
  onClose: () => void;
  /** Called when the browser cannot expose a camera; the parent opens its file picker. */
  onFallback?: () => void;
  title?: string;
}) => {
  const scanner = useDocumentScanner();
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The HD path: the phone's own camera app, through a capture input. Safari
   * on iPhone gives the page no `takePhoto()`, and its video stream tops out
   * well under the sensor; the camera app has all twelve megapixels. The
   * photo comes back here, gets its corners detected and is straightened like
   * a live capture — the live view has already done its job: framing.
   */
  const hdInput = useRef<HTMLInputElement>(null);
  const [hdBusy, setHdBusy] = useState(false);
  const fromCameraApp = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setHdBusy(true);
    try {
      const doc = await scanner.processStill(file);
      if (doc) onScanned(doc);
      else setError('Aucune page trouvée sur cette photo. Réessayez avec la feuille entière et à plat.');
    } finally {
      setHdBusy(false);
    }
  };

  // Lock page scroll behind the scanner: a full-screen viewfinder that scrolls
  // under the finger is a viewfinder the finger cannot hold still.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const shoot = async () => {
    setError(null);
    setFlash(true);
    setTimeout(() => setFlash(false), 220);
    try {
      const doc = await scanner.capture();
      // Null = the frame was no longer valid at the instant of the tap. Not
      // an error: the contour already says why.
      if (doc) onScanned(doc);
    } catch {
      setError("La capture n'a pas abouti. Réessayez.");
    }
  };

  const tone = STATUS_TONE[scanner.verdict.status];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top)+12px)]">
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-2xl leading-none backdrop-blur"
          aria-label="Fermer le scanner"
        >
          ×
        </button>
        <span className="rounded-full bg-black/50 px-3 py-1.5 text-sm font-medium backdrop-blur">{title}</span>
        <span className="h-11 w-11" />
      </div>

      {scanner.permission === 'granted' || scanner.permission === 'checking' ? (
        <>
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={scanner.videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 h-full w-full object-cover"
            />
            {scanner.permission === 'granted' && (
              <>
                <ScannerOverlay corners={scanner.verdict.corners} tone={tone} frame={scanner.frame} />
                <ScannerStatus status={scanner.verdict.status} />
              </>
            )}
            {scanner.permission === 'checking' && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
                Ouverture de la caméra…
              </div>
            )}
            {flash && <div className="pointer-events-none absolute inset-0 animate-pulse bg-white/80" />}
          </div>

          <div className="flex flex-col items-center gap-3 px-6 pb-[calc(env(safe-area-inset-bottom)+22px)] pt-4">
            {error && <p className="text-center text-sm text-red-300">{error}</p>}
            <div className="flex w-full items-center justify-center gap-6">
              <span className="w-24" />
              <CaptureButton
                enabled={scanner.verdict.ready && scanner.permission === 'granted'}
                busy={scanner.capturing}
                onCapture={() => void shoot()}
              />
              <span className="flex w-24 justify-start">
                {scanner.lowResolution && (
                  <button
                    type="button"
                    disabled={hdBusy || scanner.capturing}
                    onClick={() => hdInput.current?.click()}
                    className="flex flex-col items-center gap-1 rounded-xl bg-white/10 px-3 py-2 text-[12px] font-semibold text-white backdrop-blur disabled:opacity-50"
                  >
                    <span className="text-lg leading-none">📸</span>
                    {hdBusy ? 'Analyse…' : 'Photo HD'}
                  </button>
                )}
              </span>
            </div>
            <input
              ref={hdInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                void fromCameraApp(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <p className="text-center text-[12.5px] text-white/60">
              {scanner.lowResolution
                ? 'Vert = capture rapide. Pour un texte fin, « Photo HD » ouvre l’appareil photo et redresse la page automatiquement.'
                : 'La photo se prend quand le contour est vert. Tenez la feuille à plat, bien éclairée.'}
            </p>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <span className="text-5xl">📷</span>
          {scanner.permission === 'unsupported' ? (
            <>
              <p className="text-lg font-semibold">Caméra indisponible dans ce navigateur</p>
              <p className="text-sm text-white/70">
                La caméra en direct demande une connexion sécurisée (HTTPS) et un navigateur récent.
                Vous pouvez prendre la photo avec l’appareil du téléphone.
              </p>
              {onFallback && (
                <Button className="mt-2 max-w-xs" onClick={onFallback}>
                  Prendre une photo avec l’appareil
                </Button>
              )}
            </>
          ) : (
            <>
              <p className="text-lg font-semibold">Autorisez l’accès à la caméra</p>
              <p className="text-sm text-white/70">
                Le scanner a besoin de la caméra pour cadrer et photographier la page. Aucune image
                n’est enregistrée sans votre geste.
              </p>
              <Button className="mt-2 max-w-xs" onClick={() => scanner.start()}>
                Autoriser la caméra
              </Button>
              <div className="mt-3 rounded-xl bg-white/10 p-3 text-left text-[13px] leading-5 text-white/80">
                <p className="font-semibold text-white">Si rien ne s’affiche, l’accès a été refusé pour ce site :</p>
                <p className="mt-1">
                  <b>iPhone (Safari)</b> : touchez « AA » dans la barre d’adresse → Réglages du site
                  web → Caméra → Autoriser, puis rechargez.
                </p>
                <p className="mt-1">
                  <b>Android (Chrome)</b> : touchez le cadenas à côté de l’adresse → Autorisations →
                  Caméra → Autoriser, puis rechargez.
                </p>
              </div>
              {onFallback && (
                <Button variant="secondary" className="mt-2 max-w-xs" onClick={onFallback}>
                  Prendre une photo avec l’appareil
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
