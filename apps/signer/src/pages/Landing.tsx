import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ZONE_TYPE_LABEL } from '@scansign/shared';
import { documentUrl, useSendSignedScan, useShareIntro } from '../lib/queries';
import { requestLocation } from '../lib/geolocation';
import { reportStep, startPresence } from '../lib/activity';

/**
 * pdf.js only loads when a document is actually opened — it outweighs the rest
 * of the app, and a technician who only came to send photos never needs it.
 */
const SheetViewer = lazy(() => import('../components/SheetViewer'));
import { ApiRequestError } from '../lib/api';
import {
  Button,
  Card,
  ErrorBanner,
  Loading,
  Screen,
  Spinner,
  Subtitle,
  Title,
} from '../components/ui';

/**
 * The whole job, on one page.
 *
 * Three steps in the order the technician does them, because they are standing
 * somewhere with a phone and a printer and no patience for navigation:
 *
 *   1. open the documents — download or print them
 *   2. sign them by hand
 *   3. photograph or scan the signed pages and send them back
 *
 * What happens to those scans afterwards is none of their business and is not
 * shown: the operator crops the marks out on the console. This page ends at
 * "envoyé", which is the last thing the technician can affect.
 *
 * The documents listed are only the ones this link covers. A link sent for the
 * delivery notes does not show the contract filed beside them, and the API
 * refuses it too — the narrowing is not a UI courtesy.
 */
export const LandingPage = () => {
  const { token } = useParams<{ token: string }>();
  const { data, isLoading, error } = useShareIntro(token);

  const send = useSendSignedScan();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sent, setSent] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  // The console's presence dot: heartbeat while this page is open.
  useEffect(() => {
    if (!data || data.done) return;
    return startPresence();
  }, [data]);
  /** The document open in the in-page viewer. */
  const [viewing, setViewing] = useState<{ url: string; filename: string } | null>(null);

  /**
   * Open the PDF in a new tab, from which the phone can print or save it.
   *
   * The signed storage URL is fetched at click time rather than baked into the
   * page: these expire after fifteen minutes, and a technician who comes back
   * to this tab an hour later must still be able to open the document.
   */
  const openDocument = async (documentId: string, filename: string) => {
    setOpening(documentId);
    setUploadError(null);
    try {
      const { url } = await documentUrl(documentId);
      // In-page viewer, not a new tab: on a phone a new tab means losing this
      // page, and on some Androids it means a download prompt instead of a
      // view. Printing and sharing live inside the viewer.
      setViewing({ url, filename });
      reportStep('viewing');
    } catch (e) {
      setUploadError(
        e instanceof ApiRequestError ? e.message : "Ce document n'a pas pu être ouvert.",
      );
    } finally {
      setOpening(null);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);

    /**
     * Ask for the location first, when the link requires it.
     *
     * Before the upload, not after: the browser's own permission prompt appears
     * here, and a refusal must not lose the pages the technician just chose. So
     * a refusal or a failed fix simply sends the scan without a location — the
     * signature is what matters, the coordinate is corroboration.
     */
    /**
     * Always asked, not only when the link demands it: the returned page is
     * evidence, and where-and-when is what makes it worth something. The
     * browser still prompts and the technician can refuse — the pages go up
     * regardless, just without the coordinate.
     */
    let location = null as
      | { latitude: number; longitude: number; accuracy: number | null }
      | null;
    reportStep('sending');
    const outcome = await requestLocation();
    if (outcome.status === 'coords') location = outcome.coords;

    send.mutate(
      { files: Array.from(files), location },
      {
        onSuccess: (result) => {
          setSent((prev) => [...prev, ...result.returned.map((r) => r.filename)]);
          reportStep('sent');
        },
        onError: (e) =>
          setUploadError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.'),
      },
    );
    // Let the same file be chosen twice in a row.
    if (fileInput.current) fileInput.current.value = '';
  };

  if (isLoading) return <Loading label="Ouverture…" />;

  if (error) {
    // Revoked, expired and unknown are told apart by the API, and its wording
    // is what the technician can act on — "demandez-en un nouveau" rather than
    // a bare 403.
    const message =
      error instanceof ApiRequestError ? error.message : 'Ce lien de signature est invalide.';
    return (
      <Screen className="items-center justify-center gap-3 px-8 text-center">
        <span className="text-5xl">🔒</span>
        <Title>Lien indisponible</Title>
        <Subtitle>{message}</Subtitle>
        <p className="mt-2 text-sm text-ink-400">
          Contactez la personne qui vous a envoyé ce lien pour en obtenir un nouveau.
        </p>
      </Screen>
    );
  }

  if (data?.done) {
    return (
      <Screen className="items-center justify-center gap-3 px-8 text-center">
        <span className="text-6xl font-bold text-emerald-600">✓</span>
        <Title>Terminé</Title>
        <Subtitle>Ces documents sont signés. Vous pouvez fermer cette page.</Subtitle>
      </Screen>
    );
  }

  const documents = data?.folder?.documents ?? [];
  const marks = data?.marks ?? ['signature'];
  const asker = data?.sender?.trim();

  return (
    <Screen className="px-5 py-6">
      <Title>{asker ? `${asker} vous demande une signature` : 'Documents à signer'}</Title>
      <Subtitle>
        Imprimez les documents, signez-les à la main, puis renvoyez-les photographiés depuis cette
        page.
      </Subtitle>

      {/* --- 1 ---------------------------------------------------------- */}
      <section className="mt-7">
        <h2 className="text-xs font-bold uppercase tracking-wide text-ink-400">
          1 · Vos documents
        </h2>
        <div className="mt-2.5 flex flex-col gap-2">
          {documents.length === 0 ? (
            <p className="text-sm text-ink-400">Aucun document rattaché à ce lien.</p>
          ) : (
            documents.map((doc) => (
              <Card key={doc.id} onClick={() => void openDocument(doc.id, doc.filename)}>
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-lg">📄</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-ink-900">
                      {doc.filename}
                    </span>
                    <span className="mt-0.5 block text-[13px] text-ink-400">
                      {doc.pageCount} page{doc.pageCount > 1 ? 's' : ''} · voir / imprimer
                    </span>
                  </span>
                  {opening === doc.id ? (
                    <Spinner className="h-4 w-4 shrink-0" />
                  ) : (
                    <span className="shrink-0 text-ink-400">↗</span>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      </section>

      {/* --- 2 ---------------------------------------------------------- */}
      <section className="mt-7">
        <h2 className="text-xs font-bold uppercase tracking-wide text-ink-400">
          2 · Signez à la main
        </h2>
        <div className="mt-2.5 rounded-xl bg-white p-4 ring-1 ring-ink-200">
          <p className="text-sm leading-5 text-ink-600">Sur chaque document, apposez :</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {marks.map((mark) => (
              <li key={mark} className="flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                <span className="text-[15px] font-medium text-ink-900">
                  {ZONE_TYPE_LABEL[mark]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* --- 3 ---------------------------------------------------------- */}
      <section className="mt-7">
        <h2 className="text-xs font-bold uppercase tracking-wide text-ink-400">
          3 · Renvoyez les pages signées
        </h2>
        <p className="mt-1.5 text-[13px] leading-5 text-ink-400">
          Photographiez chaque page signée, bien à plat et bien éclairée, ou envoyez un scan PDF.
        </p>

        {data?.requireLocation && (
          <p className="mt-2 rounded-lg bg-ink-100 p-3 text-[12.5px] leading-4 text-ink-600">
            📍 Votre position vous sera demandée à l’envoi, comme preuve de signature sur place.
            Vous pouvez refuser : les pages seront tout de même transmises.
          </p>
        )}

        <Button
          className="mt-3"
          loading={send.isPending}
          onClick={() => fileInput.current?.click()}
        >
          Envoyer les pages signées
        </Button>
        <input
          ref={fileInput}
          type="file"
          // Images and PDFs both: a technician on site sends what their phone
          // produced, the office sends what the copier produced.
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />

        {sent.length > 0 && (
          <div className="mt-3 rounded-xl bg-emerald-50 p-3.5">
            <p className="text-sm font-semibold text-emerald-700">
              {sent.length} page{sent.length > 1 ? 's' : ''} envoyée{sent.length > 1 ? 's' : ''} ✓
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {sent.map((filename, i) => (
                <li key={`${filename}-${i}`} className="truncate text-[13px] text-emerald-800">
                  {filename}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12.5px] leading-4 text-emerald-800">
              {asker ?? 'Votre interlocuteur'} les reçoit immédiatement. Vous pouvez fermer cette
              page.
            </p>
          </div>
        )}

        {uploadError && <ErrorBanner message={uploadError} />}
      </section>

      {data?.expiresAt && (
        <p className="mt-5 text-center text-xs text-ink-400">
          Ce lien expire le {new Date(data.expiresAt).toLocaleDateString('fr-FR')}.
        </p>
      )}

      {viewing && (
        <Suspense fallback={<Loading label="Ouverture du document…" />}>
          <SheetViewer
            url={viewing.url}
            filename={viewing.filename}
            onPrint={() => reportStep('printing')}
            onClose={() => setViewing(null)}
          />
        </Suspense>
      )}
    </Screen>
  );
};
