import { useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ZONE_TYPE_INSTRUCTION,
  ZONE_TYPE_LABEL,
  type CaptureMode,
  type NormalizedRect,
  type ZoneType,
} from '@scansign/shared';
import { useShareIntro, useStartSession, useUploadMarkPhoto } from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { CameraCapture, type CaptureResult } from '../components/CameraCapture';
import {
  BackLink,
  Card,
  ErrorBanner,
  Loading,
  Screen,
  Steps,
  Subtitle,
  Title,
} from '../components/ui';

/**
 * Capture flow.
 *
 * The shutter is instant on purpose. The canvas hands us the JPEG straight
 * away, so the next screen opens on that blob immediately and the upload — plus
 * the server-side re-encode and ink detection, which take seconds over WiFi —
 * happens behind it. Waiting for the round trip before moving on made every
 * capture feel like the app had stalled.
 *
 * The signer picks how to capture, because neither way wins everywhere:
 *   single   — one photo of a sheet holding every mark, then frame each one.
 *   per_mark — one photo per mark, framed in turn.
 *
 * The number of steps follows what the folder's templates actually ask for —
 * which the link told us, as a list of types and nothing more.
 *
 * Flow state travels in history state, not the query string. Putting a session
 * id and a JSON blob of confirmed regions in a URL would make them visible,
 * editable and bookmarkable into a broken state; `navigate(..., { state })` is
 * structured-cloned by the History API and stays invisible.
 */
interface ResumeState {
  /** The session opened by the first mark. Every mark must land in it. */
  sessionId?: string;
  resumeAt?: number;
  collected?: Partial<Record<ZoneType, NormalizedRect>>;
}

export const CapturePage = () => {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const resume = (useLocation().state ?? {}) as ResumeState;

  const { data: intro, isLoading } = useShareIntro(token);
  const startSession = useStartSession();
  const uploadMark = useUploadMarkPhoto();

  const [mode, setMode] = useState<CaptureMode | null>(
    resume.resumeAt !== undefined ? 'per_mark' : null,
  );
  const [stepIndex] = useState(resume.resumeAt ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The session id, carried through the flow rather than held in a ref alone.
   *
   * Returning here from the framing screen remounts this component, so a ref is
   * empty again and a second mark would open a SECOND session. That happened —
   * the signature landed in one session, the mention in another, and the one
   * that got submitted had no signature at all.
   */
  const sessionIdRef = useRef<string | null>(resume.sessionId ?? null);

  if (isLoading) return <Loading />;

  const needed = intro?.marks?.length ? intro.marks : (['signature'] as ZoneType[]);
  const currentMark: ZoneType = needed[stepIndex] ?? 'signature';

  // --- choose how to capture ------------------------------------------------
  if (!mode) {
    return (
      <Screen className="px-5 py-6">
        <BackLink onClick={() => navigate(`/s/${token}`)}>Retour</BackLink>
        <div className="mt-2">
          <Title>Comment souhaitez-vous procéder ?</Title>
          <Subtitle>
            On vous demande {needed.map((m) => ZONE_TYPE_LABEL[m].toLowerCase()).join(', ')}.
          </Subtitle>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <Card onClick={() => setMode('single')}>
            <p className="text-[17px] font-bold text-ink-900">Une seule photo</p>
            <p className="mt-1.5 text-sm leading-5 text-ink-400">
              Posez {needed.length > 1 ? 'toutes vos marques' : 'votre signature'} sur une même
              feuille, prenez une photo, puis encadrez chaque élément.
            </p>
            <p className="mt-2.5 text-[12.5px] font-semibold text-brand-500">
              1 photo · {needed.length} cadrage(s)
            </p>
          </Card>

          <Card onClick={() => setMode('per_mark')}>
            <p className="text-[17px] font-bold text-ink-900">Une photo par élément</p>
            <p className="mt-1.5 text-sm leading-5 text-ink-400">
              Photographiez chaque élément séparément, puis ajustez le cadre au plus près de
              l’encre.
            </p>
            <p className="mt-2.5 text-[12.5px] font-semibold text-brand-500">
              {needed.length} photo(s) · {needed.length} cadrage(s)
            </p>
          </Card>
        </div>

        {error && <ErrorBanner message={error} />}
      </Screen>
    );
  }

  const onCapture = async (photo: CaptureResult) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'single') {
        // Straight to framing on the local blob. The upload, the server-side
        // re-encode and the ink detection all resolve behind that screen.
        navigate(`/s/${token}/cadrer`, {
          state: {
            photo: photo.blob,
            photoUrl: photo.url,
            photoWidth: photo.width,
            photoHeight: photo.height,
            marks: needed,
          },
        });
        return;
      }

      // --- per-mark ----------------------------------------------------------
      // Each mark still gets framed. The photo is often taken at arm's length
      // and catches the edge of the sheet or a neighbouring mark, so using the
      // whole frame blindly produced worse cutouts than a quick adjustment.
      const mark = currentMark;
      let id = sessionIdRef.current;
      if (!id) {
        // No folder id anywhere: the backend takes it from the link.
        const created = await startSession.mutateAsync({ captureMode: 'per_mark' });
        id = created.session.id;
        sessionIdRef.current = id;
      }
      const uploaded = await uploadMark.mutateAsync({ sessionId: id, mark, photo: photo.blob });

      navigate(`/s/${token}/marque/${mark}`, {
        state: {
          sessionId: id,
          photoUrl: uploaded.photo.url,
          photoWidth: uploaded.photo.width,
          photoHeight: uploaded.photo.height,
          suggestion: uploaded.suggestion ?? null,
          remaining: needed.slice(stepIndex + 1),
          collected: resume.collected ?? {},
        },
      });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "La photo n'a pas pu être envoyée.");
    } finally {
      setBusy(false);
    }
  };

  const instruction =
    mode === 'single'
      ? `Posez ${needed
          .map((m) => ZONE_TYPE_LABEL[m].toLowerCase())
          .join(', ')} sur une feuille blanche, bien à plat et bien éclairée.`
      : ZONE_TYPE_INSTRUCTION[currentMark];

  // Once a session exists the capture mode is settled: the marks already
  // uploaded belong to it, and switching would strand them.
  const locked = stepIndex > 0 || sessionIdRef.current !== null;

  return (
    <Screen>
      <div className="px-5 pb-3 pt-6">
        <button
          type="button"
          disabled={locked}
          onClick={() => setMode(null)}
          className="-ml-2 mb-2 inline-flex h-11 items-center px-2 text-base font-semibold text-brand-500 disabled:text-ink-200"
        >
          ‹ Changer de méthode
        </button>

        {mode === 'per_mark' && <Steps count={needed.length} index={stepIndex} />}

        <Title>{mode === 'per_mark' ? ZONE_TYPE_LABEL[currentMark] : 'Photo'}</Title>
        <Subtitle>{instruction}</Subtitle>
        {error && <ErrorBanner message={error} />}
      </div>

      <CameraCapture
        onCapture={(photo) => void onCapture(photo)}
        onError={setError}
        busy={busy}
        shutterLabel={
          mode === 'per_mark'
            ? `Photographier ${ZONE_TYPE_LABEL[currentMark].toLowerCase()}`
            : 'Prendre la photo'
        }
      />
    </Screen>
  );
};
