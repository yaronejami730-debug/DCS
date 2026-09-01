import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ZONE_TYPE_LABEL, type NormalizedRect, type ZoneType } from '@scansign/shared';
import { RegionSelector } from '../components/RegionSelector';
import { CutoutPreview } from '../components/CutoutPreview';
import { useStartSession, useSubmitRegions } from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { BackLink, Button, ErrorBanner, Screen, Steps, Subtitle, Title } from '../components/ui';

/**
 * Frame each mark and check its cutout, one step at a time.
 *
 * The order is deliberate: look at what was captured, then confirm the
 * background removal actually worked, before committing. Nothing here is
 * silent — every image that ends up on a contract is one the signer looked at
 * first.
 *
 * There is no variant picker on this screen, unlike the iPhone app it replaces.
 * Choosing which signature goes on which document meant listing the documents,
 * and a share link must not reveal them. The backend spreads one variant per
 * document instead.
 */
const DEFAULT_RECT: Record<ZoneType, NormalizedRect> = {
  signature: { x: 0.08, y: 0.12, width: 0.6, height: 0.28 },
  stamp: { x: 0.52, y: 0.44, width: 0.38, height: 0.36 },
  mention: { x: 0.08, y: 0.46, width: 0.5, height: 0.2 },
  signature_stamp: { x: 0.1, y: 0.16, width: 0.7, height: 0.5 },
  date: { x: 0.08, y: 0.7, width: 0.34, height: 0.14 },
  quote_date: { x: 0.55, y: 0.7, width: 0.34, height: 0.14 },
  free_text: { x: 0.08, y: 0.46, width: 0.6, height: 0.2 },
  checkbox: { x: 0.08, y: 0.08, width: 0.16, height: 0.14 },
};

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

const FRAMING_HINT: Record<ZoneType, string> = {
  signature: 'Ajustez le cadre autour de votre signature uniquement.',
  stamp: 'Ajustez le cadre autour de votre tampon.',
  signature_stamp: 'Encadrez le tampon et la signature ensemble.',
  mention: 'Ajustez le cadre autour de la mention « Lu et approuvé ».',
  date: 'Ajustez le cadre autour de la date.',
  quote_date: 'Ajustez le cadre autour de la date de devis.',
  free_text: 'Ajustez le cadre autour du texte.',
  checkbox: 'Ajustez le cadre autour de la case cochée.',
};

interface CaptureState {
  photo: Blob;
  photoUrl: string;
  photoWidth: number;
  photoHeight: number;
  marks: ZoneType[];
}

export const SelectRegionsPage = () => {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const state = useLocation().state as CaptureState | null;

  const startSession = useStartSession();
  const submit = useSubmitRegions();

  const [stepIndex, setStepIndex] = useState(0);
  const [regions, setRegions] = useState<Partial<Record<ZoneType, NormalizedRect>>>({});
  const [detected, setDetected] = useState<Partial<Record<ZoneType, NormalizedRect>>>({});
  const [error, setError] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const [photoDims, setPhotoDims] = useState({
    width: state?.photoWidth ?? 1,
    height: state?.photoHeight ?? 1,
  });
  const [uploading, setUploading] = useState(false);
  const [readySessionId, setReadySessionId] = useState<string | null>(null);
  const uploadRef = useRef<Promise<string> | null>(null);
  const touched = useRef(false);

  /**
   * The upload, started once and left to run behind the framing.
   *
   * StrictMode mounts every effect twice in development, and without this ref
   * that meant two sessions per capture — the second one holding the photo, the
   * first one getting the regions.
   */
  useEffect(() => {
    if (!state?.photo || uploadRef.current) return;

    setUploading(true);
    uploadRef.current = startSession
      .mutateAsync({ captureMode: 'single', photo: state.photo })
      .then((created) => {
        if (created.photo) {
          // The server re-encodes and bakes in the EXIF orientation, so its
          // dimensions are authoritative over what the canvas reported.
          setPhotoDims((prev) =>
            prev.width === created.photo!.width && prev.height === created.photo!.height
              ? prev
              : { width: created.photo!.width, height: created.photo!.height },
          );
        }
        const found = created.suggestions ?? {};
        const usable: Partial<Record<ZoneType, NormalizedRect>> = {};
        for (const [key, value] of Object.entries(found)) {
          if (value) usable[key as ZoneType] = value as NormalizedRect;
        }
        // Never move a box the signer has already put where they want it.
        if (Object.keys(usable).length > 0 && !touched.current) setDetected(usable);
        setReadySessionId(created.session.id);
        setUploading(false);
        return created.session.id;
      })
      .catch((e: unknown) => {
        setUploading(false);
        setError(e instanceof ApiRequestError ? e.message : "L'envoi de la photo a échoué.");
        throw e;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.photo]);

  const steps = state?.marks?.length ? state.marks : (['signature'] as ZoneType[]);
  const step = steps[stepIndex] ?? 'signature';
  const isLast = stepIndex === steps.length - 1;
  const current = regions[step] ?? null;

  const handleChange = useCallback(
    (rect: NormalizedRect) => {
      touched.current = true;
      setRegions((prev) => ({ ...prev, [step]: rect }));
    },
    [step],
  );

  /**
   * A blob URL does not survive a reload, and neither does history state, so
   * there is nothing to render and nothing to recover. Back to the camera,
   * where the flow can be restarted — better than a broken framing screen.
   */
  if (!state?.photoUrl) return <Navigate to={`/s/${token}/photo`} replace />;

  const reset = () => {
    setRegions((prev) => {
      const next = { ...prev };
      delete next[step];
      return next;
    });
    setResetToken((n) => n + 1);
  };

  /**
   * Wait for the photo upload rather than refusing to act on it.
   *
   * The button used to be disabled while the upload ran, which on a slow
   * connection looked exactly like a dead button. It now stays pressable and
   * the press waits, so a tap always does something.
   */
  const resolveSessionId = async (): Promise<string> => {
    if (readySessionId) return readySessionId;
    if (uploadRef.current) return uploadRef.current;
    throw new ApiRequestError(0, "La photo n'a pas été envoyée. Reprenez la photo.");
  };

  const send = async (final: Partial<Record<ZoneType, NormalizedRect>>) => {
    if (!final.signature && !final.signature_stamp) {
      setError('Sélectionnez au moins une signature.');
      return;
    }
    setError(null);
    try {
      const sessionId = await resolveSessionId();
      await submit.mutateAsync({
        sessionId,
        regions: {
          signature: final.signature ?? null,
          stamp: final.stamp ?? null,
          mention: final.mention ?? null,
          signature_stamp: final.signature_stamp ?? null,
        },
      });
      navigate(`/s/${token}/traitement/${sessionId}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.');
    }
  };

  const advance = () => {
    if (isLast) void send(regions);
    else setStepIndex(stepIndex + 1);
  };

  const skip = () => {
    const without = { ...regions };
    delete without[step];
    setRegions(without);
    if (isLast) void send(without);
    else setStepIndex(stepIndex + 1);
  };

  const wasDetected = Boolean(detected[step]);

  return (
    <Screen className="px-5 py-6">
      <BackLink onClick={() => navigate(`/s/${token}/photo`)}>Reprendre la photo</BackLink>

      <div className="mt-2">
        <Steps count={steps.length} index={stepIndex} />
        <Title>Cadrez : {ZONE_TYPE_LABEL[step].toLowerCase()}</Title>
        <Subtitle>{FRAMING_HINT[step]}</Subtitle>
      </div>

      {wasDetected && (
        <div className="mt-2.5 rounded-lg bg-brand-50 px-3 py-2 text-[13px] font-semibold text-brand-500">
          Cadre placé automatiquement — vérifiez et ajustez si besoin.
        </div>
      )}

      <div className="mt-[18px]">
        <RegionSelector
          key={`${step}-${resetToken}-${wasDetected ? 'auto' : 'manual'}`}
          photoUrl={state.photoUrl}
          photoWidth={photoDims.width}
          photoHeight={photoDims.height}
          value={current}
          defaultRect={detected[step] ?? DEFAULT_RECT[step]}
          onChange={handleChange}
          tint={TINT[step]}
        />
      </div>

      <CutoutPreview
        sessionId={readySessionId}
        mark={step}
        region={current}
        enabled={Boolean(readySessionId) && !uploading}
      />

      {uploading && (
        <p className="mt-3 text-center text-[13px] text-ink-400">Envoi de la photo en cours…</p>
      )}
      {error && <ErrorBanner message={error} />}

      <div className="mt-6 flex flex-col gap-2.5">
        <Button onClick={advance} loading={submit.isPending} disabled={!current}>
          {isLast ? 'Valider' : 'Continuer'}
        </Button>
        {step !== 'signature' && step !== 'signature_stamp' && (
          <Button variant="secondary" onClick={skip} loading={submit.isPending}>
            Pas de {ZONE_TYPE_LABEL[step].toLowerCase()}
          </Button>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={reset}>
            Réinitialiser
          </Button>
          {stepIndex > 0 && (
            <Button variant="ghost" onClick={() => setStepIndex(stepIndex - 1)}>
              Étape précédente
            </Button>
          )}
        </div>
      </div>
    </Screen>
  );
};
