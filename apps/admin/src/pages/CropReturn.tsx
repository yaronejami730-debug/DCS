import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  HANDWRITTEN_MARKS,
  ZONE_TYPE_LABEL,
  marksToCapture,
  sheetFieldsForDocument,
  type Document,
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
  useClassifyMark,
  useDetectSheet,
  usePreviewVariants,
  type SheetDetection,
  type SheetFieldDetection,
} from '../lib/queries';
import { api, ApiRequestError } from '../lib/api';
import { detectSheetOnImage, openScanPage } from '../lib/sheetPage';
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
  invoice_date: '#d96b16',
  free_text: '#2a8a96',
  checkbox: '#5a6472',
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

type ServedState = 'processing' | 'completed' | 'error' | 'skipped';

/**
 * The names the sheet routing reads off a folder document.
 *
 * The box a document's signature comes from is, in order: the box its zones
 * name ("Signature repère 2" drawn on the template), the template's own choice,
 * else the keywords in its name — resolved by sheetFieldsForDocument.
 */
const routingDoc = (
  d: Document,
  zones: ReadonlyArray<{ type: ZoneType; sheetField?: string | null }> = [],
) => ({
  filename: d.filename,
  templateName: d.template?.name ?? null,
  sheetField:
    zones.find((z) => z.type === 'signature' && z.sheetField)?.sheetField ??
    d.template?.sheetField ??
    null,
});

/**
 * What the sheet can do for one document.
 *
 * The document's template says which marks it needs; the sheet says which
 * boxes were written in and which documents each box is for. Crossing the two
 * gives a verdict the operator can act on without picking anything:
 *
 *   ready    every mark the template asks for has a filled box addressed to it;
 *   partial  some have, some are empty on the sheet or have no box at all;
 *   blocked  nothing on the sheet can go onto this document;
 *   done     already signed, or served in this session;
 *   no_zones the template has no zone — nothing to fill;
 *   loading  zones not fetched yet.
 */
interface PlanEntry {
  doc: Document;
  status: 'loading' | 'no_zones' | 'blocked' | 'partial' | 'ready' | 'done';
  /** Marks the template asks for. */
  types: ZoneType[];
  /** Filled boxes that go onto this document, by mark. */
  provided: Array<{ type: ZoneType; field: SheetFieldDetection }>;
  /** Boxes addressed to this document that nobody wrote in. */
  empty: Array<{ type: ZoneType; field: SheetFieldDetection }>;
  /** Marks the template asks for that no box of the sheet is for. */
  unrouted: ZoneType[];
}

const STATUS_LABEL: Record<PlanEntry['status'], string> = {
  loading: 'Lecture des zones…',
  no_zones: 'Aucune zone sur le template',
  blocked: 'Rien à apposer',
  partial: 'Incomplet',
  ready: 'Prêt à apposer',
  done: 'Déjà signé',
};

const STATUS_TONE: Record<PlanEntry['status'], string> = {
  loading: 'bg-ink-100 text-ink-500',
  no_zones: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  blocked: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  partial: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  ready: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  done: 'bg-ink-100 text-ink-500',
};

export const CropReturnPage = () => {
  const { id: folderId = '', returnId = '' } = useParams<{ id: string; returnId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const { data: folder } = useFolder(folderId);
  const { data: returns } = useReturns(folderId);

  const startSession = useStartCropSession();
  const submit = useSubmitRegions();
  const markHandled = useMarkReturnHandled();
  const classify = useClassifyMark();
  const detectSheet = useDetectSheet();
  /**
   * The printed capture sheet, if this page is one.
   *
   * Detected once per page and kept across the sessions opened on it: the
   * photo does not change between documents, so neither do the boxes.
   */
  const [sheet, setSheet] = useState<SheetDetection | null>(null);
  const [sheetChecked, setSheetChecked] = useState(false);
  const sheetFor = useRef<string>('');
  /** Which (document, session) pair the boxes were already dropped onto. */
  const autoFilledFor = useRef<string>('');
  const [autoRunning, setAutoRunning] = useState(false);
  /** Show the hand-framing controls even though a sheet was recognised. */
  const [manual, setManual] = useState(false);
  const previewVariants = usePreviewVariants();
  /**
   * Variants of each filled handwritten box, as the plan will stamp them: the
   * base and two more, so the operator sees that two zones of one document
   * will not carry the same bitmap. Loaded once per box, in the background.
   */
  const [variantPreviews, setVariantPreviews] = useState<
    Record<string, Array<{ index: number; dataUrl: string }> | 'loading' | 'failed'>
  >({});
  /** The type Claude recognised for the current box, offered as a chip. */
  const [suggested, setSuggested] = useState<{ type: ZoneType; confidence: number | null } | null>(
    null,
  );
  const classifiedFor = useRef<string>('');

  const item = returns?.items.find((r) => r.id === returnId);
  const contracts = (folder?.documents ?? []).filter((d) => d.role !== 'for_signing');

  /**
   * Zones of every contract at once — the plan needs all of them, not the one
   * the operator would have picked. Fetched only once a sheet is recognised.
   */
  const zoneQueries = useQueries({
    queries: contracts.map((d) => ({
      queryKey: ['document-zones', d.id],
      queryFn: () =>
        api<{ zones: Array<{ type: ZoneType; sheetField?: string | null }> }>(
          `/documents/${d.id}/placement`,
        ),
      enabled: Boolean(sheet),
      staleTime: 60_000,
    })),
  });
  const zoneData = zoneQueries.map((q) => q.data);

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
  /** The return whose pages were already searched for the sheet. */
  const autoPagedFor = useRef<string | null>(null);
  /** Monotonic run counter for the prepare effect; see its `myRun`. */
  const prepareRun = useRef(0);
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
  /** The local object URL currently shown, revoked when replaced or on unmount. */
  const localUrlRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    },
    [],
  );

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

    /**
     * Which run is current. A run is stale — and stops committing state —
     * when a newer one has started (page change, retry). It is NOT stale when
     * React merely re-invokes the effect: StrictMode in development runs the
     * cleanup and the effect again on mount, and the guard above then lets the
     * first run carry on. Cancelling in the cleanup instead left that run mute
     * and the guard refusing a second — a spinner that lasted the full 40 s
     * ceiling, which is what "the crop page is slow" actually was.
     */
    const myRun = ++prepareRun.current;
    let cancelled = false;
    const isStale = () => cancelled || prepareRun.current !== myRun;
    if (localUrlRef.current) {
      URL.revokeObjectURL(localUrlRef.current);
      localUrlRef.current = null;
    }

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
      if (isStale()) return;
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
      setSheet(null);
      setSheetChecked(false);
      sheetFor.current = '';
      autoFilledFor.current = '';
      try {
        setPrepareStep('Ouverture du scan…');
        const url = urlRef.current;
        if (!url) throw new Error('URL du scan indisponible');

        /**
         * A multi-page PDF opens on the page that carries the capture sheet.
         *
         * Searched once per return, and only when the URL did not name a
         * page: the attestation's markers are on page 2, and opening on page 1
         * read as "the markers are not detected". The search reuses the very
         * render shown on screen, so it costs nothing on the common case and a
         * page or two of drawing otherwise.
         */
        let blob: Blob;
        let localSheet: SheetDetection | null = null;
        if (item.contentType === 'application/pdf') {
          const search =
            (item.pageCount ?? 1) > 1 && !params.get('page') && autoPagedFor.current !== item.id;
          autoPagedFor.current = item.id;
          const rendered = await openScanPage(url, page, {
            search,
            pageCount: item.pageCount ?? 1,
            onStep: (label) => {
              if (!isStale()) setPrepareStep(label);
            },
          });
          if (isStale()) return;
          if (rendered.page !== page) {
            // Keep the guard in step with the page now shown, so the effect's
            // re-run for the new page number does not prepare it a second time.
            preparedFor.current = `${item.id}:${rendered.page}`;
            setPage(rendered.page);
          }
          blob = rendered.blob;
          localSheet = rendered.sheet;
        } else {
          blob = await fetchImage(url);
        }
        if (isStale()) return;
        setPageBlob(blob);

        /**
         * Show the frame at once, from the blob we already hold.
         *
         * The old flow waited for the upload, the server re-encode and a signed
         * URL round-trip — ten seconds of spinner before the operator could
         * touch anything. But framing only needs the pixels, which are already
         * here. So the image is shown from a local object URL immediately and
         * the session is opened in the background; only the cutout preview and
         * the apply button wait on it, and by the time the operator has drawn a
         * box it has long since arrived.
         */
        const bitmap = await createImageBitmap(blob);
        if (isStale()) {
          bitmap.close();
          return;
        }
        // A photo return: detect here too, on the decoded bitmap.
        if (!localSheet && item.contentType !== 'application/pdf') {
          localSheet = detectSheetOnImage(bitmap, bitmap.width, bitmap.height);
        }
        const localUrl = URL.createObjectURL(blob);
        localUrlRef.current = localUrl;
        setPhoto({ url: localUrl, width: bitmap.width, height: bitmap.height });
        bitmap.close();
        /**
         * The boxes, now — from the detection made while rendering. The server
         * is asked only when the browser found nothing, as a second opinion;
         * waiting on the upload and a round trip before drawing a single box
         * was most of what made this page feel slow.
         */
        if (localSheet) {
          setSheet(localSheet);
          setSheetChecked(true);
          sheetFor.current = 'local';
        }
        setPreparing(false);
        clearTimeout(deadline);

        // Background: open the signing session on the same blob.
        startSession
          .mutateAsync({ folderId, returnId: item.id, page: blob })
          .then((created) => {
            if (!isStale()) setSessionId(created.session.id);
          })
          .catch((e) => {
            if (!isStale()) {
              setError(
                e instanceof ApiRequestError
                  ? e.message
                  : "La préparation du détourage a échoué. Réessayez.",
              );
              preparedFor.current = null;
            }
          });
      } catch (e) {
        if (!isStale()) {
          setError(
            e instanceof ApiRequestError ? e.message : "Cette page n'a pas pu être préparée.",
          );
          preparedFor.current = null;
          clearTimeout(deadline);
          setPreparing(false);
        }
      }
    };
    void run();
    // No cleanup on purpose: see `myRun`. A superseded run goes stale by the
    // counter; an unmounted one commits into nothing, which React tolerates.

    // item?.url deliberately absent: it changes on every poll. See urlRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, page, folderId, retryToken]);

  const handleChange = useCallback((rect: NormalizedRect) => setCurrent(rect), []);

  /**
   * Look for the sheet's markers as soon as the first session on this page is
   * open. One call per page: later sessions reuse the same photo.
   */
  useEffect(() => {
    if (!sessionId || !item) return;
    // The browser already read the sheet off the render: nothing to ask.
    if (sheetFor.current === 'local') return;
    // Per session, not per page: when the page changed, the effect fired once
    // more with the OLD session still in state, recorded the new page as done,
    // and then skipped the session that actually held the new page's photo.
    const key = sessionId;
    if (sheetFor.current === key) return;
    sheetFor.current = key;
    detectSheet.mutate(
      { sessionId },
      {
        onSuccess: (r) => {
          setSheet(r.sheet);
          setSheetChecked(true);
        },
        onError: () => setSheetChecked(true),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, item?.id, page]);

  /**
   * Recognise the framed mark's type once the box has settled.
   *
   * Keyed on the rounded rectangle so it fires once per distinct box, not on
   * every pixel of a drag, and only when a session and a document exist. The
   * result is a suggestion the operator applies with a tap — never applied on
   * its own, so a wrong guess is free.
   */
  useEffect(() => {
    if (!sessionId || !current || !targetDoc) return;
    const key = [current.x, current.y, current.width, current.height]
      .map((n) => n.toFixed(3))
      .join(',');
    if (classifiedFor.current === key) return;
    const timer = setTimeout(() => {
      classifiedFor.current = key;
      classify.mutate(
        { sessionId, region: current },
        {
          onSuccess: (r) => {
            if (r.available && r.type && markChoices.includes(r.type)) {
              setSuggested({ type: r.type, confidence: r.confidence });
            } else {
              setSuggested(null);
            }
          },
          onError: () => setSuggested(null),
        },
      );
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, targetDoc, current?.x, current?.y, current?.width, current?.height]);

  // Clear a stale suggestion when the box is cleared or the mark changes.
  useEffect(() => {
    if (!current) setSuggested(null);
  }, [current]);

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

  /**
   * Drop the sheet's boxes onto the selector for the chosen document.
   *
   * This is the point of the markers: the operator picks the document and the
   * boxes meant for it are already framed, typed and listed — the signature
   * from the right group, the mention, the name, the date — each still a
   * rectangle they can drag. Once per (document, session), so a box they
   * removed on purpose does not come back on the next render.
   */
  useEffect(() => {
    if (!sheet || !sessionId || !targetDoc || zonesLoading) return;
    const key = `${targetDoc}:${sessionId}`;
    if (autoFilledFor.current === key) return;
    const doc = contracts.find((d) => d.id === targetDoc);
    if (!doc) return;
    autoFilledFor.current = key;

    // Only boxes someone wrote in: an empty box would be extracted as nothing
    // and fail the whole pass with « aucune trace d'encre ».
    const picked = sheetFieldsForDocument(
      sheet.fields.filter((f) => f.filled),
      routingDoc(doc, documentZones),
      zoneTypesInDoc,
    );
    const next: Partial<Record<ZoneType, NormalizedRect>> = {};
    for (const [type, field] of Object.entries(picked) as Array<[ZoneType, (typeof sheet.fields)[number]]>) {
      next[type] = field.rect;
    }
    const types = Object.keys(next) as ZoneType[];
    setRegions(next);
    if (types.length > 0) {
      const first = markChoices.find((m) => types.includes(m)) ?? types[0]!;
      setMark(first);
      const rect = next[first]!;
      // Show the box where it landed, and do not ask Claude what it is: the
      // sheet already says.
      classifiedFor.current = [rect.x, rect.y, rect.width, rect.height]
        .map((n) => n.toFixed(3))
        .join(',');
      setCurrent(rect);
      setResetToken((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, sessionId, targetDoc, zonesLoading, zoneTypesInDoc.join(',')]);

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
          invoice_date: only('invoice_date'),
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

      // Move to the next unserved contract on the same scan page.
      setRegions({});
      setCurrent(null);
      setResetToken((n) => n + 1);
      setSessionId(null);
      const servedIds = new Set([...served.map((s) => s.id), targetDoc]);
      const nextDoc = contracts.find((d) => !servedIds.has(d.id));
      setTargetDoc(nextDoc?.id ?? '');
      // Only open a fresh session when there is a document left to place on —
      // a session with nothing to receive it would sit unused.
      if (nextDoc && pageBlob) {
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

  useEffect(() => {
    if (!sheet || !sessionId || manual) return;
    const pending = sheet.fields.filter(
      (f) => f.filled && HANDWRITTEN_MARKS.includes(f.type) && !variantPreviews[f.id],
    );
    if (pending.length === 0) return;
    let stopped = false;
    void (async () => {
      for (const field of pending) {
        if (stopped) return;
        setVariantPreviews((prev) => ({ ...prev, [field.id]: 'loading' }));
        try {
          const r = await previewVariants.mutateAsync({
            sessionId,
            mark: field.type,
            region: field.rect,
            count: 3,
          });
          if (!stopped) setVariantPreviews((prev) => ({ ...prev, [field.id]: r.variants }));
        } catch {
          if (!stopped) setVariantPreviews((prev) => ({ ...prev, [field.id]: 'failed' }));
        }
      }
    })();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, sessionId, manual]);

  const plan: PlanEntry[] = useMemo(() => {
    if (!sheet) return [];
    return contracts.map((doc, i) => {
      const base = { doc, types: [] as ZoneType[], provided: [], empty: [], unrouted: [] };
      if (doc.status === 'completed' || served.some((s) => s.id === doc.id)) {
        return { ...base, status: 'done' as const };
      }
      const data = zoneData[i];
      if (!data) return { ...base, status: 'loading' as const };
      const types = Array.from(new Set(data.zones.map((z) => z.type)));
      if (types.length === 0) return { ...base, status: 'no_zones' as const };
      const picked = sheetFieldsForDocument(sheet.fields, routingDoc(doc, data.zones), types);
      const provided: PlanEntry['provided'] = [];
      const empty: PlanEntry['empty'] = [];
      const unrouted: ZoneType[] = [];
      for (const type of types) {
        const field = picked[type];
        if (!field) unrouted.push(type);
        else if (field.filled) provided.push({ type, field });
        else empty.push({ type, field });
      }
      const status =
        provided.length === 0 ? 'blocked' : empty.length + unrouted.length > 0 ? 'partial' : 'ready';
      return { doc, status, types, provided, empty, unrouted };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, contracts, served, ...zoneData]);

  /**
   * Serve every remaining document from the sheet, without a single drag.
   *
   * For each contract still unserved: open a session on the page (the first
   * one reuses the session already open), read its zones, pick the boxes the
   * sheet addresses to it, submit. A document none of the boxes fits is
   * skipped and said so, not failed. Each pass is the exact submission the
   * manual button makes — same pipeline, same audit trail.
   */
  const applyEntries = async (entries: PlanEntry[]) => {
    if (!sheet || !pageBlob || entries.length === 0) return;
    setAutoRunning(true);
    setError(null);
    try {
      let session = sessionId;
      let handled = false;
      for (const entry of entries) {
        if (entry.provided.length === 0) {
          setServed((prev) => [...prev, { id: entry.doc.id, state: 'skipped' }]);
          continue;
        }
        if (!session) {
          const created = await startSession.mutateAsync({ folderId, returnId, page: pageBlob });
          session = created.session.id;
        }
        const rect = (t: ZoneType) => entry.provided.find((p) => p.type === t)?.field.rect ?? null;
        const submittedSession = session;
        const docId = entry.doc.id;
        await submit.mutateAsync({
          sessionId: submittedSession,
          regions: {
            signature: rect('signature'),
            stamp: rect('stamp'),
            mention: rect('mention'),
            signature_stamp: rect('signature_stamp'),
            date: rect('date'),
            quote_date: rect('quote_date'),
            invoice_date: rect('invoice_date'),
            free_text: rect('free_text'),
            checkbox: rect('checkbox'),
            documentIds: [docId],
          },
        });
        session = null;
        handled = true;
        setServed((prev) => [...prev, { id: docId, state: 'processing' }]);
        void (async () => {
          for (let i = 0; i < 40; i++) {
            try {
              const st = await api<SigningSession>(`/signing-sessions/${submittedSession}`);
              if (st.status === 'completed' || st.status === 'error') {
                setServed((prev) =>
                  prev.map((x) =>
                    x.id === docId
                      ? { ...x, state: st.status === 'completed' ? 'completed' : 'error' }
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
      }
      if (handled) markHandled.mutate({ folderId, returnId });
      setSessionId(session);
      setRegions({});
      setCurrent(null);
      setResetToken((n) => n + 1);
      setTargetDoc('');
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Apposition automatique impossible.');
    } finally {
      setAutoRunning(false);
    }
  };

  /** Every document the plan says is ready, in one go. */
  const autoApplyAll = () => applyEntries(plan.filter((e) => e.status === 'ready'));

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

              {sheet && (
                <div className="mb-3 rounded-lg bg-emerald-50 p-3 ring-1 ring-emerald-200">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>📐</span>
                    <p className="text-sm font-semibold text-emerald-800">
                      Feuille de signature reconnue — {sheet.fields.length} cases repérées
                    </p>
                    {sheet.rotation !== 0 && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        Feuille tournée de {sheet.rotation}° : les marques seront apposées tournées
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {sheet.fields.map((f) => (
                      <span
                        key={f.id}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          f.filled ? 'bg-white text-emerald-900 ring-1 ring-emerald-200' : 'bg-white/60 text-ink-400'
                        }`}
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: TINT[f.type], opacity: f.filled ? 1 : 0.35 }}
                        />
                        {ZONE_TYPE_LABEL[f.type]}
                        {f.type === 'signature' ? ` · ${f.label.toLowerCase()}` : ''}
                        {f.filled ? '' : ' · vide'}
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => setManual((v) => !v)}
                      className="ml-auto text-xs font-medium text-emerald-800 underline"
                    >
                      {manual ? 'Revenir au plan automatique' : 'Ajuster à la main'}
                    </button>
                  </div>
                </div>
              )}
              {sheetChecked && !sheet && detectSheet.isPending === false && (
                <p className="mb-2 text-xs text-ink-400">
                  Pas de feuille de signature reconnue sur cette page : encadrez les marques à la
                  main.
                </p>
              )}
              {detectSheet.isPending && (
                <p className="mb-2 text-xs text-ink-400">Recherche des repères de la feuille…</p>
              )}

              <RegionSelector
                key={`${mark}-${resetToken}-${page}`}
                photoUrl={photo.url}
                photoWidth={photo.width}
                photoHeight={photo.height}
                value={current}
                onChange={handleChange}
                tint={TINT[mark]}
                ghostsOnly={Boolean(sheet) && !manual}
                ghosts={(sheet?.fields ?? [])
                  // Every detected box, in its type's colour; the active mark's
                  // own box is drawn by the selector itself.
                  .filter((f) => manual ? !(regions[f.type] && f.type === mark) : true)
                  .map((f) => ({
                    id: f.id,
                    rect: f.rect,
                    tint: TINT[f.type],
                    label: f.filled ? ZONE_TYPE_LABEL[f.type] : `${ZONE_TYPE_LABEL[f.type]} · vide`,
                    muted: !f.filled,
                  }))}
              />
            </>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          {sheet && !manual ? (
            <Card className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-400">
                Plan d’apposition
              </p>
              <p className="mt-1 text-xs text-ink-400">
                Ce que chaque document exige, d’après son template, et ce que la feuille fournit.
              </p>
              {plan.length === 0 ? (
                <p className="mt-3 text-sm text-ink-400">Aucun document à faire signer dans ce dossier.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2.5">
                  {plan.map((entry) => (
                    <li key={entry.doc.id} className="rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200/70">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink-900">{entry.doc.filename}</p>
                          <p className="truncate text-[11px] text-ink-400">
                            {entry.doc.template?.name
                              ? `Template « ${entry.doc.template.name} »`
                              : 'Sans template'}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[entry.status]}`}
                        >
                          {STATUS_LABEL[entry.status]}
                        </span>
                      </div>
                      {(entry.status === 'ready' || entry.status === 'partial' || entry.status === 'blocked') && (
                        <ul className="mt-2 flex flex-col gap-1 text-xs">
                          {entry.provided.map((p) => (
                            <li key={p.type} className="flex items-center gap-1.5 text-emerald-800">
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TINT[p.type] }} />
                              {ZONE_TYPE_LABEL[p.type]}
                              {p.type === 'signature' ? ` ← case ${p.field.label}` : ''}
                            </li>
                          ))}
                          {entry.empty.map((p) => (
                            <li key={p.type} className="flex items-center gap-1.5 text-amber-800">
                              <span className="h-2 w-2 rounded-full opacity-40" style={{ backgroundColor: TINT[p.type] }} />
                              {ZONE_TYPE_LABEL[p.type]} : case {p.type === 'signature' ? `« ${p.field.label} » ` : ''}vide sur la feuille
                            </li>
                          ))}
                          {entry.unrouted.map((t) => (
                            <li key={t} className="flex items-center gap-1.5 text-red-700">
                              <span className="h-2 w-2 rounded-full opacity-40" style={{ backgroundColor: TINT[t] }} />
                              {ZONE_TYPE_LABEL[t]} : aucune case de la feuille ne vise ce document
                              {t === 'signature' ? ' — nommez le template (devis, AH, stockage…) ou choisissez sa case dans son éditeur' : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                      {entry.status === 'no_zones' && (
                        <p className="mt-2 text-xs text-amber-800">
                          Ouvrez le template et placez les zones à remplir.
                        </p>
                      )}
                      {(entry.status === 'ready' || entry.status === 'partial') && (
                        <Button
                          variant={entry.status === 'ready' ? 'primary' : 'secondary'}
                          className="mt-2.5 w-full"
                          disabled={autoRunning || !pageBlob}
                          loading={autoRunning}
                          onClick={() => void applyEntries([entry])}
                        >
                          {entry.status === 'ready'
                            ? 'Apposer sur ce document'
                            : `Apposer seulement ${entry.provided.map((p) => ZONE_TYPE_LABEL[p.type].toLowerCase()).join(', ')}`}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {plan.filter((e) => e.status === 'ready').length > 1 && (
                <Button
                  className="mt-3 w-full"
                  loading={autoRunning}
                  disabled={!pageBlob}
                  onClick={() => void autoApplyAll()}
                >
                  Apposer les {plan.filter((e) => e.status === 'ready').length} documents prêts
                </Button>
              )}
              {plan.some((e) => e.status === 'partial' || e.status === 'blocked') && (
                <p className="mt-2 text-xs text-amber-800">
                  Attention : des cases sont vides ou ne visent aucun document. Ces zones des PDF
                  resteraient vides. Complétez la feuille et renvoyez-la, ou ajustez à la main.
                </p>
              )}
            </Card>
          ) : (
          <>
          <Card className="p-4">
            {/*
              The operator's sentence, as controls: THESE marks go on THAT
              document. The document comes first because it is the decision;
              the marks are the work.
            */}
            {(() => {
              // Only documents not yet handled: a signed one leaves the list so
              // what remains is exactly what is still to do. Once every contract
              // is served the picker is replaced by a done state.
              const servedIds = new Set(served.map((sv) => sv.id));
              const remaining = contracts.filter((d) => !servedIds.has(d.id));
              if (remaining.length === 0) {
                return (
                  <div className="rounded-lg bg-emerald-50 p-3.5 text-center">
                    <p className="text-sm font-semibold text-emerald-800">
                      Tous les documents ont été traités ✓
                    </p>
                  </div>
                );
              }
              return (
                <Select
                  label={`Pour quel document ? (${remaining.length} restant${
                    remaining.length > 1 ? 's' : ''
                  })`}
                  value={targetDoc}
                  onChange={(e) => setTargetDoc(e.target.value)}
                >
                  <option value="">— choisir —</option>
                  {remaining.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.filename}
                    </option>
                  ))}
                </Select>
              );
            })()}

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
                <>
                {suggested && suggested.type !== mark && (
                  <button
                    type="button"
                    onClick={() => {
                      setMark(suggested.type);
                      setSuggested(null);
                    }}
                    className="mb-2 flex w-full items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-left text-sm text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100"
                  >
                    <span>✨</span>
                    <span className="flex-1">
                      Reconnu : <span className="font-semibold">{ZONE_TYPE_LABEL[suggested.type]}</span>
                      {suggested.confidence != null
                        ? ` (${Math.round(suggested.confidence * 100)} %)`
                        : ''}
                    </span>
                    <span className="font-medium underline">Appliquer</span>
                  </button>
                )}
                {classify.isPending && (
                  <p className="mb-2 text-xs text-ink-400">Reconnaissance du type…</p>
                )}
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
                </>
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
          </>
          )}

          {sheet && !manual && sheet.fields.some((f) => f.filled && HANDWRITTEN_MARKS.includes(f.type)) && (
            <Card className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-400">
                Variantes générées
              </p>
              <p className="mt-1 text-xs text-ink-400">
                Chaque zone d’un document reçoit une variante différente de la même case : deux
                signatures sur une AH ne sont jamais le même dessin.
              </p>
              <ul className="mt-3 flex flex-col gap-3">
                {sheet.fields
                  .filter((f) => f.filled && HANDWRITTEN_MARKS.includes(f.type))
                  .map((f) => {
                    const state = variantPreviews[f.id];
                    return (
                      <li key={f.id}>
                        <p className="flex items-center gap-1.5 text-xs font-medium text-ink-700">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TINT[f.type] }} />
                          Variantes · {f.type === 'signature' ? `repère ${f.label}` : ZONE_TYPE_LABEL[f.type]}
                        </p>
                        {!state || state === 'loading' ? (
                          <p className="mt-1 text-xs text-ink-400">Génération…</p>
                        ) : state === 'failed' ? (
                          <p className="mt-1 text-xs text-amber-700">Aperçu indisponible pour cette case.</p>
                        ) : (
                          <div className="mt-1.5 grid grid-cols-3 gap-2">
                            {state.map((v) => (
                              <div
                                key={v.index}
                                className="flex h-16 items-center justify-center rounded-lg bg-white p-1 ring-1 ring-ink-200"
                              >
                                <img src={v.dataUrl} alt="" className="max-h-full max-w-full object-contain" />
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </Card>
          )}

          {served.length > 0 && (
            <Card className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-400">
                Documents servis
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {served.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    <span className="shrink-0">
                      {s.state === 'completed'
                        ? '✅'
                        : s.state === 'error'
                          ? '❌'
                          : s.state === 'skipped'
                            ? '⏭'
                            : '⏳'}
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
