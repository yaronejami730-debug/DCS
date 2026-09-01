import { useEffect, useRef, useState } from 'react';
import type { ExtractionEngine, NormalizedRect, ZoneType } from '@scansign/shared';
import { usePreviewCutout } from '../lib/queries';
import { Spinner } from './ui';

/**
 * Shows what the extraction engine actually produces for the framed region —
 * the transparent cutout that will be stamped onto the contract.
 *
 * This is the one part of the pipeline that cannot be judged from the scan
 * itself: a pale stamp, or a shadow across the paper, looks fine on screen and
 * comes out empty. Seeing the result while the box can still be widened — or
 * another page of the scan chosen — is the difference between fixing it now and
 * finding it in the signed document.
 *
 * Two engines can be asked, side by side, because which one cuts a given mark
 * better is not decidable in the abstract — it depends on the pen, the paper
 * and the light. The local container is free and keeps the photo on our own
 * server; remove.bg is a metered third-party API. Both run on the same crop, so
 * the comparison is honest.
 */
export const CutoutPreview = ({
  sessionId,
  mark,
  region,
  enabled,
}: {
  sessionId: string | null;
  mark: ZoneType;
  region: NormalizedRect | null;
  /** False while the session is still uploading. */
  enabled: boolean;
}) => {
  const preview = usePreviewCutout();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [shownEngine, setShownEngine] = useState<ExtractionEngine | null>(null);
  const [fellBack, setFellBack] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [running, setRunning] = useState<ExtractionEngine | null>(null);
  const latest = useRef(0);

  const run = (engine: ExtractionEngine) => {
    if (!sessionId || !region || !enabled) return;
    const attempt = ++latest.current;
    setFailed(null);
    setStale(false);
    setRunning(engine);
    preview.mutate(
      { sessionId, mark, region, engine },
      {
        onSuccess: (result) => {
          // A slow request must not overwrite a newer one.
          if (attempt !== latest.current) return;
          setDataUrl(result.dataUrl);
          setShownEngine(result.engine ?? engine);
          setFellBack(result.fellBack === true);
          setRunning(null);
        },
        onError: (error) => {
          if (attempt !== latest.current) return;
          setDataUrl(null);
          setShownEngine(null);
          setFellBack(false);
          setRunning(null);
          const message = error instanceof Error ? error.message : '';
          setFailed(
            /encre/i.test(message)
              ? "Aucune trace d'encre détectée dans ce cadre."
              : /remove\.bg/i.test(message)
                ? // The remote engine fails for reasons the signer can act on —
                  // no key, no credits — so its own words are worth showing.
                  message
                : 'Aperçu indisponible.',
          );
        },
      },
    );
  };

  // Mark the current preview stale as soon as the box moves, so the signer is
  // never looking at a cutout of a region they have already changed.
  useEffect(() => {
    if (!dataUrl) return;
    setStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region?.x, region?.y, region?.width, region?.height]);

  const busy = running !== null;
  const disabled = !enabled || !region || busy;

  const engineButton = (engine: ExtractionEngine, title: string, subtitle: string) => (
    <button
      type="button"
      onClick={() => run(engine)}
      disabled={disabled}
      className={`flex min-h-[46px] flex-1 flex-col items-center justify-center rounded-xl bg-white px-2 py-1.5 ring-1 transition ${
        shownEngine === engine ? 'bg-brand-50 ring-brand-500' : 'ring-ink-200'
      } ${disabled ? 'opacity-45' : 'active:bg-ink-50'}`}
    >
      {running === engine ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <>
          <span className="text-[13.5px] font-bold text-brand-500">{title}</span>
          <span className="text-[11px] text-ink-400">{subtitle}</span>
        </>
      )}
    </button>
  );

  return (
    <div className="mt-4">
      <span className="text-xs font-bold uppercase tracking-wide text-ink-400">
        Aperçu du détourage
      </span>

      <div className="mt-2 flex gap-2">
        {engineButton('removebg', 'remove.bg', 'par défaut')}
        {engineButton('local', 'Moteur local', 'comparer')}
      </div>

      {/*
        White, not grey. A cutout is black ink on transparency, and grey behind
        it is what made every preview look washed out even once the extraction
        was correct — the ink had nothing to be dark against. Paper is what it
        will actually be stamped on, so paper is what it is judged against.
      */}
      <div className="relative mt-2.5 flex min-h-[132px] items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-ink-200">
        {busy ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <Spinner />
            <span className="text-[12.5px] text-ink-400">Détourage en cours…</span>
          </div>
        ) : dataUrl ? (
          <>
            <img src={dataUrl} alt="" className="h-[156px] w-full object-contain" />
            {shownEngine && (
              <span className="absolute left-1.5 top-1.5 rounded-full bg-ink-900/75 px-2 py-0.5 text-[10.5px] font-bold text-white">
                {fellBack
                  ? 'Moteur local (remove.bg indisponible)'
                  : shownEngine === 'removebg'
                    ? 'remove.bg'
                    : 'Moteur local'}
              </span>
            )}
            {stale && (
              <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink-900/80 px-2.5 py-1 text-[11.5px] font-semibold text-white">
                Cadre modifié — relancez
              </span>
            )}
          </>
        ) : failed ? (
          <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
            <span className="text-[13.5px] font-semibold text-red-600">{failed}</span>
            <span className="text-[12.5px] text-ink-400">
              Élargissez le cadre ou reprenez la photo.
            </span>
          </div>
        ) : (
          <span className="px-4 py-6 text-center text-[12.5px] text-ink-400">
            {enabled
              ? 'Vérifiez ce qui sera réellement apposé sur le document.'
              : 'Envoi de la photo en cours…'}
          </span>
        )}
      </div>
    </div>
  );
};
