import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ShareLink } from '@scansign/shared';
import { useCreateShareLink } from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { Button, Modal, Spinner } from './ui';

/**
 * Carry on from your own phone.
 *
 * The capture step needs a camera, and the console runs on a desk. So the
 * operator mints a link for *themselves*, scans it off their own screen, and
 * the phone picks up where the desk left off — with the documents and their
 * zones visible, because it is their folder.
 *
 * A QR code rather than emailing yourself a URL: the token is 43 characters of
 * base64, which is unusable by hand, and the phone is already in their hand
 * pointed at the screen. The camera app resolves it in a second.
 *
 * Short-lived by default. This link is meant to be consumed in the next
 * minute, on the phone in the room; a self-link with a month of life is a
 * credential left lying around for no benefit.
 */
const HANDOFF_TTL_DAYS = 1;

export const PhoneHandoff = ({ folderId }: { folderId: string }) => {
  const create = useCreateShareLink();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * A fresh link each time the dialog opens.
   *
   * Reusing one would be cheaper, but an operator opens this because they are
   * about to sign *now*; a token minted last week has been on screen, in a
   * screenshot, and possibly in someone else's photo of the monitor.
   */
  const start = () => {
    setOpen(true);
    setLink(null);
    setPng(null);
    setError(null);
    create.mutate(
      { folderId, scope: 'operator', label: 'Mon téléphone', expiresInDays: HANDOFF_TTL_DAYS },
      {
        onSuccess: setLink,
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Création du lien impossible.'),
      },
    );
  };

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    // Rendered to a data URL rather than a canvas ref: the dialog mounts the
    // image and the code in the same paint, so there is no frame where the
    // operator sees an empty white square and reaches for their phone anyway.
    QRCode.toDataURL(link.url, { width: 320, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setPng(url);
      })
      .catch(() => {
        if (!cancelled) setError('Le QR code n’a pas pu être généré.');
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  return (
    <>
      <Button variant="secondary" onClick={start}>
        📱 Signer sur mon téléphone
      </Button>

      <Modal open={open} title="Continuer sur votre téléphone" onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Scannez ce code avec l’appareil photo de votre téléphone. Vous y retrouverez ce
            dossier, ses documents et leurs zones, pour photographier votre signature.
          </p>

          <div className="flex justify-center rounded-xl bg-white p-4 ring-1 ring-ink-200">
            {png ? (
              <img src={png} alt="QR code du lien" className="h-56 w-56" />
            ) : error ? (
              <p className="py-16 text-sm text-red-600">{error}</p>
            ) : (
              <div className="flex h-56 items-center justify-center">
                <Spinner />
              </div>
            )}
          </div>

          {link && (
            <>
              {/*
                The URL in full, for the case the QR will not scan — a dim
                screen, a cracked lens, a locked-down camera app. Selectable,
                because typing 43 characters of base64 is not an option.
              */}
              <input
                readOnly
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-lg bg-ink-50 px-2.5 py-1.5 font-mono text-xs text-ink-600 ring-1 ring-ink-200 outline-none"
              />
              <p className="text-xs text-ink-400">
                Ce lien vaut accès à ce dossier et expire dans 24 h. Ne le transmettez pas — pour
                faire signer quelqu’un d’autre, créez un lien de signature, qui lui ne montre
                aucun document.
              </p>
            </>
          )}

          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Fermer
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};
