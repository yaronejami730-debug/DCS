import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ZONE_TYPE_LABEL,
  marksToCapture,
  type NormalizedRect,
  type ZoneType,
} from '@scansign/shared';
import {
  useFolder,
  useRequiredMarks,
  useReturns,
  useStartCropSession,
  useSubmitRegions,
  useSession,
  useMarkReturnHandled,
} from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { Page } from '../components/Layout';
import { RegionSelector } from '../components/RegionSelector';
import { CutoutPreview } from '../components/CutoutPreview';
import { Button, Card, Select, Spinner } from '../components/ui';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Crop the marks out of a page the technician sent back.
 *
 * This is the step that used to happen on the phone and now belongs here, for a
 * simple reason: the technician signed on paper and has no idea which zone each
 * mark is destined for. The operator does — they configured the zones — and
 * they are sitting in front of a screen large enough to frame a signature
 * accurately, which a phone held at arm's length is not.
 *
 * The pipeline underneath is unchanged. One page of the returned scan is
 * rasterised here, uploaded as a signing session's photo, and from that point
 * on it is the same extraction, the same variants and the same stamping the
 * capture flow always used. What changed is only where the photo comes from and
 * who draws the boxes.
 */

const TINT: Record<ZoneType, string> = {
  signature: '#2f5fe0',
  stamp: '#0f9d58',
  mention: '#b7791f',
  signature_stamp: '#8b3fbf',
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

/** Fetch an already-image return as a blob, so both kinds upload identically. */
const fetchImage = async (url: string): Promise<Blob> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('téléchargement impossible');
  return res.blob();
};

export const CropReturnPage = () => {
  const { id: folderId = '', returnId = '' } = useParams<{ id: string; returnId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const { data: folder } = useFolder(folderId);
  const { data: returns } = useReturns(folderId);
  const { data: requiredMarks } = useRequiredMarks(folderId);
  const startSession = useStartCropSession();
  const submit = useSubmitRegions();
  const markHandled = useMarkReturnHandled();

  const item = returns?.items.find((r) => r.id === returnId);

  const [page, setPage] = useState(Number(params.get('page') ?? 1) || 1);
  const [photo, setPhoto] = useState<{ url: string; width: number; height: number } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mark, setMark] = useState<ZoneType>('signature');
  const [regions, setRegions] = useState<Partial<Record<ZoneType, NormalizedRect>>>({});
  const [current, setCurrent] = useState<NormalizedRect | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const { data: session } = useSession(sessionId ?? undefined, submit.isSuccess);
  const preparedFor = useRef<string | null>(null);

  /**
   * Prepare the page: rasterise it if it is a PDF, then open a session on it.
   *
   * Keyed on return + page so switching page re-prepares, and guarded by a ref
   * so React's double-mount in development does not open two sessions on the
   * same scan — the second would hold the photo and the first would get the
   * regions.
   */
  useEffect(() => {
    if (!item?.url || !folderId) return;
    const key = `${item.id}:${page}`;
    if (preparedFor.current === key) return;
    preparedFor.current = key;

    let cancelled = false;
    const run = async () => {
      setPreparing(true);
      setError(null);
      setSessionId(null);
      setRegions({});
      setCurrent(null);
      try {
        const blob =
          item.contentType === 'application/pdf'
            ? await rasterise(item.url!, page)
            : await fetchImage(item.url!);
        if (cancelled) return;

        const created = await startSession.mutateAsync({
          folderId,
          returnId: item.id,
          page: blob,
        });
        if (cancelled) return;

        setSessionId(created.session.id);
        if (created.photo) setPhoto(created.photo);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiRequestError ? e.message : "Cette page n'a pas pu être préparée.",
          );
          // Let a retry re-run rather than sticking on the failed key.
          preparedFor.current = null;
        }
      } finally {
        if (!cancelled) setPreparing(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.url, page, folderId]);

  const handleChange = useCallback((rect: NormalizedRect) => setCurrent(rect), []);

  /**
   * The marks worth offering: what this folder's templates actually describe.
   *
   * Asked of the server rather than inferred from the documents in hand — zones
   * live on templates, and a document row says nothing about how many
   * signatures its template wants.
   */
  const markChoices: ZoneType[] = marksToCapture(requiredMarks ?? {});

  const assign = () => {
    if (!current) return;
    setRegions((prev) => ({ ...prev, [mark]: current }));
    // Move to the next unassigned mark, so a three-mark page is three clicks
    // rather than three trips through the dropdown.
    const next = markChoices.find((m) => m !== mark && !regions[m]);
    if (next) setMark(next);
    setCurrent(null);
    setResetToken((n) => n + 1);
  };

  const send = () => {
    if (!sessionId) return;
    setError(null);
    submit.mutate(
      {
        sessionId,
        regions: {
          signature: regions.signature ?? null,
          stamp: regions.stamp ?? null,
          mention: regions.mention ?? null,
          signature_stamp: regions.signature_stamp ?? null,
        },
      },
      {
        onSuccess: () => markHandled.mutate({ folderId, returnId }),
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.'),
      },
    );
  };

  const assigned = Object.keys(regions) as ZoneType[];
  const canSend = Boolean(regions.signature || regions.signature_stamp);
  const done = session?.status === 'completed';
  const failed = session?.status === 'error';

  if (!item) return <Spinner />;

  return (
    <Page
      title="Recadrer les signatures"
      description={`${item.filename} · reçu pour ${folder?.name ?? 'ce dossier'}`}
      actions={
        <Button variant="secondary" onClick={() => navigate(`/folders/${folderId}`)}>
          Retour au dossier
        </Button>
      }
    >
      {error && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      {submit.isSuccess && (
        <Card className="mb-4 border-l-4 border-l-emerald-500 p-4">
          <p className="text-sm font-medium text-emerald-800">
            {done
              ? 'Documents signés ✓'
              : failed
                ? 'Le traitement a échoué.'
                : 'Traitement en cours…'}
          </p>
          <p className="mt-1 text-sm text-ink-600">
            {done
              ? 'Les marques ont été apposées sur les documents de ce dossier.'
              : failed
                ? (session?.errorMessage ?? 'Consultez le dossier pour le détail.')
                : 'Les marques sont en cours d’application sur les documents.'}
          </p>
          {done && (
            <Button className="mt-3" onClick={() => navigate(`/folders/${folderId}`)}>
              Voir le dossier
            </Button>
          )}
        </Card>
      )}

      {!submit.isSuccess && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-4">
            {preparing || !photo ? (
              <div className="py-16">
                <Spinner />
                <p className="mt-2 text-center text-sm text-ink-400">
                  Préparation de la page…
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
                      <Button
                        variant="secondary"
                        disabled={page <= 1}
                        onClick={() => setPage(page - 1)}
                      >
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
                Zones validées
              </p>
              {assigned.length === 0 ? (
                <p className="mt-2 text-sm text-ink-400">
                  Encadrez une marque dans le scan, choisissez ce qu’elle est, puis validez.
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
                disabled={!canSend}
                loading={submit.isPending}
                onClick={send}
              >
                Apposer sur les documents
              </Button>
              {!canSend && (
                <p className="mt-2 text-xs text-ink-400">
                  Une signature est nécessaire — les autres marques sont facultatives.
                </p>
              )}
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
};
