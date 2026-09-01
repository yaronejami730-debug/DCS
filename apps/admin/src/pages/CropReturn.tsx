import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ZONE_TYPE_LABEL,
  marksToCapture,
  type NormalizedRect,
  type SigningSession,
  type ZoneType,
} from '@scansign/shared';
import {
  useDocumentZones,
  useFolder,
  useReturns,
  useStartCropSession,
  useSubmitRegions,
  useMarkReturnHandled,
} from '../lib/queries';
import { api, ApiRequestError } from '../lib/api';
import { Page } from '../components/Layout';
import { RegionSelector } from '../components/RegionSelector';
import { CutoutPreview } from '../components/CutoutPreview';
import { Button, Card, Select, Spinner } from '../components/ui';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Crop the marks out of a returned scan — one contract at a time.
 *
 * The operator's sentence is "this signature goes on that document": they frame
 * the marks meant for one contract, send them, and move to the next. Each pass
 * runs the full existing pipeline — extraction, variants, stamping onto the
 * zones that contract's template describes — but aimed at a single document via
 * the submission's documentIds, instead of blanketing the folder.
 *
 * A signing session can only be submitted once, so each pass gets a fresh one:
 * the rasterised page is kept as a blob and re-uploaded per pass. A few hundred
 * kilobytes per contract is a fair price for never mutating a session that is
 * already processing.
 */

const TINT: Record<ZoneType, string> = {
  signature: '#2f5fe0',
  stamp: '#0f9d58',
  mention: '#b7791f',
  signature_stamp: '#8b3fbf',
  date: '#c02a55',
  quote_date: '#d96b16',
  free_text: '#2a8a96',
  checkbox: '#5a6472',
};

/**
 * Render one page of the scan to a JPEG.
 *
 * Scale 2 rather than 1: the extraction engine works on the crop, and a
 * signature occupying a tenth of an A4 page rendered at screen resolution is a
 * hundred pixels of ink with nothing to separate from the paper.
 */
const rasterise = async (url: string, page: number): Promise<Blob> => {
  const doc = await pdfjs.getDocument({ url }).promise;
  const pdfPage = await doc.getPage(page);
  const viewport = pdfPage.getViewport({ scale: 2 });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas indisponible');

  // White behind the page: a PDF renders with a transparent background, and a
  // transparent JPEG becomes black, against which no ink is findable.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encodage impossible'))),
      'image/jpeg',
      0.92,
    );
  });
};

/**
 * Fetch an already-image return and cap its long edge before upload.
 *
 * Phones return 12MP originals; uploading 3024×4032 and letting the server
 * shrink it cost tens of seconds of spinner. 2400px keeps every stroke the
 * extraction engine can use — it works on the crop, not the page — at a
 * quarter of the bytes.
 */
const MAX_EDGE = 2400;

const fetchImage = async (url: string): Promise<Blob> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('téléchargement impossible');
  const source = await res.blob();

  const bitmap = await createImageBitmap(source).catch(() => null);
  if (!bitmap) return source;
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) {
    bitmap.close();
    return source;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return source;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b ?? source), 'image/jpeg', 0.92);
  });
};

type ServedState = 'processing' | 'completed' | 'error';

export const CropReturnPage = () => {
  const { id: folderId = '', returnId = '' } = useParams<{ id: string; returnId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const { data: folder } = useFolder(folderId);
  const { data: returns } = useReturns(folderId);

  const startSession = useStartCropSession();
  const submit = useSubmitRegions();
  const markHandled = useMarkReturnHandled();

  const item = returns?.items.find((r) => r.id === returnId);
  const contracts = (folder?.documents ?? []).filter((d) => d.role !== 'for_signing');

  const [page, setPage] = useState(Number(params.get('page') ?? 1) || 1);
  const [pageBlob, setPageBlob] = useState<Blob | null>(null);
  const [photo, setPhoto] = useState<{ url: string; width: number; height: number } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  /** What the long first load is actually doing — a silent spinner reads as a hang. */
  const [prepareStep, setPrepareStep] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [targetDoc, setTargetDoc] = useState<string>('');
  const [mark, setMark] = useState<ZoneType>('signature');
  const [regions, setRegions] = useState<Partial<Record<ZoneType, NormalizedRect>>>({});
  const [current, setCurrent] = useState<NormalizedRect | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [applying, setApplying] = useState(false);
  /** documentId -> outcome, in the order they were served. */
  const [served, setServed] = useState<Array<{ id: string; state: ServedState }>>([]);

  const { data: zonesData, isLoading: zonesLoading } = useDocumentZones(targetDoc || undefined);

  const preparedFor = useRef<string | null>(null);
  /** Bumped by the retry button to force the prepare effect to run again. */
  const [retryToken, setRetryToken] = useState(0);
  /**
   * The scan's signed URL, read through a ref on purpose.
   *
   * The returns list repolls every 4s and each poll signs a FRESH url for the
   * same scan. With the url in the effect's deps, every poll re-ran the
   * effect, whose cleanup cancelled the download in flight — and the prepare
   * guard then blocked any restart. Net effect: a spinner stuck on
   * « Téléchargement du scan… » forever. The effect now keys on the stable
   * identity (return id + page) and reads whichever url is current when it
   * actually fetches.
   */
  const urlRef = useRef<string | undefined>(item?.url);
  urlRef.current = item?.url;

  // First unserved contract is the natural next target.
  useEffect(() => {
    if (targetDoc || contracts.length === 0) return;
    const servedIds = new Set(served.map((s) => s.id));
    const next = contracts.find((d) => !servedIds.has(d.id));
    if (next) setTargetDoc(next.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts.length]);

  /**
   * Prepare the page: rasterise it if it is a PDF, keep the blob, open the
   * first session on it. Guarded by a ref so React's dev double-mount cannot
   * open two sessions on the same scan.
   */
  useEffect(() => {
    if (!item?.url || !folderId) return;
    const key = `${item.id}:${page}`;
    if (preparedFor.current === key) return;
    preparedFor.current = key;

    let cancelled = false;

    /**
     * A hard ceiling on preparation.
     *
     * Everything inside is supposed to resolve in a few seconds, but a hung
     * fetch, a wedged rasterise, or a cold serverless function that never
     * answers would otherwise leave the spinner turning forever — which is
     * exactly the failure being chased. Past this, the attempt is abandoned
     * with an error the operator can retry, so the page can never loop.
     */
    const HARD_LIMIT_MS = 40_000;
    const deadline = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      preparedFor.current = null;
      setPreparing(false);
      setError(
        'La préparation a pris trop de temps. Vérifiez votre connexion, puis réessayez.',
      );
    }, HARD_LIMIT_MS);

    const run = async () => {
      setPreparing(true);
      setError(null);
      setSessionId(null);
      setRegions({});
      setCurrent(null);
      try {
        setPrepareStep('Téléchargement du scan…');
        const url = urlRef.current;
        if (!url) throw new Error('URL du scan indisponible');
        const blob =
          item.contentType === 'application/pdf'
            ? await rasterise(url, page)
            : await fetchImage(url);
        if (cancelled) return;
        setPageBlob(blob);

        setPrepareStep('Envoi et préparation… (quelques secondes au premier chargement)');
        const created = await startSession.mutateAsync({ folderId, returnId: item.id, page: blob });
        if (cancelled) return;
        setSessionId(created.session.id);
        if (created.photo) setPhoto(created.photo);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiRequestError ? e.message : "Cette page n'a pas pu être préparée.",
          );
          preparedFor.current = null;
        }
      } finally {
        clearTimeout(deadline);
        if (!cancelled) setPreparing(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
    // item?.url deliberately absent: it changes on every poll. See urlRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, page, folderId, retryToken]);

  const handleChange = useCallback((rect: NormalizedRect) => setCurrent(rect), []);

  /**
   * The marks this target document actually has zones for.
   *
   * Picking the document first is the point: the operator says "this goes on
   * that contract", and the capture types then narrow to what that contract can
   * receive. A mark with no matching zone in the document would be extracted
   * and then have nowhere to land — the engine matches by type — so it must not
   * be offered here.
   */
  const documentZones = zonesData?.zones ?? [];
  const zoneTypesInDoc = Array.from(new Set(documentZones.map((z) => z.type)));
  const markChoices: ZoneType[] = marksToCapture(
    Object.fromEntries(zoneTypesInDoc.map((t) => [t, 1])),
  ).filter((m) => zoneTypesInDoc.includes(m));

  // Keep the selected mark inside what the chosen document offers. Picking a
  // new document whose zones do not include the current mark would otherwise
  // leave a stale, unplaceable type selected.
  useEffect(() => {
    if (markChoices.length > 0 && !markChoices.includes(mark)) {
      setMark(markChoices[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetDoc, markChoices.length]);

  const assign = () => {
    if (!current) return;
    setRegions((prev) => ({ ...prev, [mark]: current }));
    const next = markChoices.find((m) => m !== mark && !regions[m]);
    if (next) setMark(next);
    setCurrent(null);
    setResetToken((n) => n + 1);
  };

  /**
   * Send this pass's marks at the chosen contract, then open a fresh session
   * for the next one.
   *
   * The submission response predates the inline processing's outcome, so the
   * session is fetched again until it settles — which in production is usually
   * the very first fetch, the work having run inside the request.
   */
  const apply = async () => {
    if (!sessionId || !targetDoc) return;
    setApplying(true);
    setError(null);
    try {
      // Only the zones this document can actually place. A capture the operator
      // made for a type the document lacks is dropped rather than sent to be
      // matched against a zone that does not exist.
      const only = (t: ZoneType) => (markChoices.includes(t) ? (regions[t] ?? null) : null);
      await submit.mutateAsync({
        sessionId,
        regions: {
          signature: only('signature'),
          stamp: only('stamp'),
          mention: only('mention'),
          signature_stamp: only('signature_stamp'),
          date: only('date'),
          quote_date: only('quote_date'),
          free_text: only('free_text'),
          checkbox: only('checkbox'),
          documentIds: [targetDoc],
        },
      });
      setServed((prev) => [...prev, { id: targetDoc, state: 'processing' }]);
      markHandled.mutate({ folderId, returnId });

      const settledFor = targetDoc;
      void (async () => {
        for (let i = 0; i < 40; i++) {
          try {
            const s = await api<SigningSession>(`/signing-sessions/${sessionId}`);
            if (s.status === 'completed' || s.status === 'error') {
              setServed((prev) =>
                prev.map((x) =>
                  x.id === settledFor
                    ? { ...x, state: s.status === 'completed' ? 'completed' : 'error' }
                    : x,
                ),
              );
              return;
            }
          } catch {
            /* transient; keep polling */
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
      })();

      // Fresh session for the next contract, same page.
      setRegions({});
      setCurrent(null);
      setResetToken((n) => n + 1);
      setSessionId(null);
      const servedIds = new Set([...served.map((s) => s.id), targetDoc]);
      const nextDoc = contracts.find((d) => !servedIds.has(d.id));
      setTargetDoc(nextDoc?.id ?? '');
      if (pageBlob) {
        const created = await startSession.mutateAsync({
          folderId,
          returnId,
          page: pageBlob,
        });
        setSessionId(created.session.id);
        if (created.photo) setPhoto(created.photo);
      }
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.');
    } finally {
      setApplying(false);
    }
  };

  const assigned = Object.keys(regions) as ZoneType[];
  /**
   * Ready to apply once at least one captured zone matches a zone the target
   * document actually has. Not "a signature specifically": a document whose
   * template only asks for a date is satisfied by a date.
   */
  const usableAssigned = assigned.filter((m) => markChoices.includes(m));
  const canApply = Boolean(usableAssigned.length > 0 && targetDoc && sessionId);
  const docName = (id: string) => contracts.find((d) => d.id === id)?.filename ?? id;

  if (!item) return <Spinner />;

  return (
    <Page
      title="Capturer les signatures"
      description={`${item.filename} · reçu pour ${folder?.name ?? 'ce dossier'}`}
      actions={
        <Button variant="secondary" onClick={() => navigate(`/folders/${folderId}`)}>
          Retour au dossier
        </Button>
      }
    >
      {error && photo && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="p-4">
          {error && !preparing ? (
            <div className="flex flex-col items-center gap-3 py-16">
              <span className="text-3xl">⚠️</span>
              <p className="max-w-sm text-center text-sm text-red-700">{error}</p>
              <Button
                onClick={() => {
                  preparedFor.current = null;
                  setError(null);
                  setRetryToken((n) => n + 1);
                }}
              >
                Réessayer
              </Button>
            </div>
          ) : preparing || !photo ? (
            <div className="py-16">
              <Spinner />
              <p className="mt-2 text-center text-sm text-ink-400">
                {prepareStep || 'Préparation de la page…'}
              </p>
            </div>
          ) : (
            <>
              {(item.pageCount ?? 1) > 1 && (
                <div className="mb-3 flex items-center gap-3">
                  <span className="text-sm text-ink-600">
                    Page {page} sur {item.pageCount}
                  </span>
                  <div className="ml-auto flex gap-2">
                    <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      ‹ Précédente
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={page >= (item.pageCount ?? 1)}
                      onClick={() => setPage(page + 1)}
                    >
                      Suivante ›
                    </Button>
                  </div>
                </div>
              )}

              <RegionSelector
                key={`${mark}-${resetToken}-${page}`}
                photoUrl={photo.url}
                photoWidth={photo.width}
                photoHeight={photo.height}
                value={current}
                onChange={handleChange}
                tint={TINT[mark]}
              />
            </>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            {/*
              The operator's sentence, as controls: THESE marks go on THAT
              document. The document comes first because it is the decision;
              the marks are the work.
            */}
            <Select
              label="Pour quel document ?"
              value={targetDoc}
              onChange={(e) => setTargetDoc(e.target.value)}
            >
              <option value="">— choisir —</option>
              {contracts.map((d) => (
                <option key={d.id} value={d.id}>
                  {served.some((s) => s.id === d.id) ? '✓ ' : ''}
                  {d.filename}
                </option>
              ))}
            </Select>

            <div className="mt-3">
              {!targetDoc ? (
                <p className="text-sm text-ink-400">
                  Choisissez d’abord le document : les zones proposées seront celles configurées
                  dessus.
                </p>
              ) : zonesLoading ? (
                <p className="text-sm text-ink-400">Chargement des zones du document…</p>
              ) : markChoices.length === 0 ? (
                <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  Ce document n’a aucune zone configurée. Ouvrez-le dans « Documents à faire
                  signer » pour y placer des zones avant de capturer.
                </p>
              ) : (
                <Select
                  label="Cette zone est…"
                  value={mark}
                  onChange={(e) => {
                    setMark(e.target.value as ZoneType);
                    setCurrent(regions[e.target.value as ZoneType] ?? null);
                    setResetToken((n) => n + 1);
                  }}
                >
                  {markChoices.map((m) => (
                    <option key={m} value={m}>
                      {ZONE_TYPE_LABEL[m]}
                      {regions[m] ? ' ✓' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            <Button className="mt-3 w-full" disabled={!current} onClick={assign}>
              Valider cette zone
            </Button>

            <CutoutPreview
              sessionId={sessionId}
              mark={mark}
              region={current}
              enabled={Boolean(sessionId) && !preparing}
            />
          </Card>

          <Card className="p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-400">
              Zones validées pour ce document
            </p>
            {assigned.length === 0 ? (
              <p className="mt-2 text-sm text-ink-400">
                Encadrez une marque dans le scan, dites ce qu’elle est, validez — puis choisissez
                le document qui la reçoit.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {assigned.map((m) => (
                  <li key={m} className="flex items-center gap-2 text-sm">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: TINT[m] }}
                    />
                    <span className="flex-1">{ZONE_TYPE_LABEL[m]}</span>
                    <button
                      onClick={() =>
                        setRegions((prev) => {
                          const next = { ...prev };
                          delete next[m];
                          return next;
                        })
                      }
                      className="text-xs font-medium text-red-600 hover:underline"
                    >
                      Retirer
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <Button
              className="mt-4 w-full"
              disabled={!canApply}
              loading={applying}
              onClick={() => void apply()}
            >
              Détourer et apposer sur ce document
            </Button>
            {!canApply && !targetDoc && (
              <p className="mt-2 text-xs text-amber-700">Choisissez le document destinataire.</p>
            )}
            {!canApply && targetDoc && usableAssigned.length === 0 && (
              <p className="mt-2 text-xs text-ink-400">
                Validez au moins une zone qui existe sur ce document.
              </p>
            )}
          </Card>

          {served.length > 0 && (
            <Card className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-400">
                Documents servis
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {served.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    <span className="shrink-0">
                      {s.state === 'completed' ? '✅' : s.state === 'error' ? '❌' : '⏳'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{docName(s.id)}</span>
                  </li>
                ))}
              </ul>
              <Button
                variant="secondary"
                className="mt-3 w-full"
                onClick={() => navigate(`/folders/${folderId}`)}
              >
                Terminer — voir le dossier
              </Button>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
};
