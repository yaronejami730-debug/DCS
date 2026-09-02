import { useCallback, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ZONE_TYPE_LABEL, type NormalizedRect, type ZoneType } from '@scansign/shared';
import { RegionSelector } from '../components/RegionSelector';
import { CutoutPreview } from '../components/CutoutPreview';
import { useSubmitRegions } from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { BackLink, Button, ErrorBanner, Screen, Subtitle, Title } from '../components/ui';

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
 * Frame one mark, in the per-photo-per-mark flow.
 *
 * Using the whole frame blindly was tempting but worse in practice: a photo
 * taken at arm's length catches the edge of the sheet, a shadow, or the mark
 * next to it, and the extraction engine then has more than the ink to deal
 * with. A quick adjustment, with the cutout visible, is a few seconds well
 * spent.
 */
interface FrameState {
  sessionId: string;
  photoUrl: string;
  photoWidth: number;
  photoHeight: number;
  suggestion: NormalizedRect | null;
  remaining: ZoneType[];
  collected: Partial<Record<ZoneType, NormalizedRect>>;
}

export const FrameMarkPage = () => {
  const { token = '', mark: markParam } = useParams<{ token: string; mark: string }>();
  const navigate = useNavigate();
  const state = useLocation().state as FrameState | null;

  const submit = useSubmitRegions();

  const mark = (markParam ?? 'signature') as ZoneType;
  const [region, setRegion] = useState<NormalizedRect | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleChange = useCallback((rect: NormalizedRect) => setRegion(rect), []);

  // The photo URL and the marks confirmed so far live in history state, which a
  // reload discards. Nothing here can be rebuilt from the URL alone.
  if (!state?.photoUrl) return <Navigate to={`/s/${token}/photo`} replace />;

  const sessionId = state.sessionId;

  // The whole frame is a sane default here: the photo was taken for this mark
  // alone. Detection narrows it when it found the ink.
  const startingRect = state.suggestion ?? { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };

  const confirm = async () => {
    if (!region) return;
    const next = { ...state.collected, [mark]: region };

    if (state.remaining.length > 0) {
      // Back to the camera for the next mark, carrying what is confirmed — and
      // the session id, or the next mark opens a new one and this mark's photo
      // is orphaned.
      navigate(`/s/${token}/photo`, {
        replace: true,
        state: {
          sessionId,
          resumeAt: Object.keys(next).length,
          collected: next,
        },
      });
      return;
    }

    setError(null);
    try {
      await submit.mutateAsync({
        sessionId,
        regions: {
          signature: next.signature ?? null,
          stamp: next.stamp ?? null,
          mention: next.mention ?? null,
          signature_stamp: next.signature_stamp ?? null,
        },
      });
      navigate(`/s/${token}/traitement/${sessionId}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.');
    }
  };

  return (
    <Screen className="px-5 py-6">
      <BackLink onClick={() => navigate(`/s/${token}/photo`, { replace: true })}>
        Reprendre la photo
      </BackLink>

      <div className="mt-2">
        <Title>Cadrez : {ZONE_TYPE_LABEL[mark].toLowerCase()}</Title>
        <Subtitle>
          Ajustez le cadre au plus près de l’encre, puis vérifiez l’aperçu du détourage.
        </Subtitle>
      </div>

      {state.suggestion && (
        <div className="mt-2.5 rounded-lg bg-brand-50 px-3 py-2 text-[13px] font-semibold text-brand-500">
          Cadre placé automatiquement — vérifiez et ajustez si besoin.
        </div>
      )}

      <div className="mt-[18px]">
        <RegionSelector
          key={`${mark}-${resetToken}`}
          photoUrl={state.photoUrl}
          photoWidth={state.photoWidth || 1}
          photoHeight={state.photoHeight || 1}
          value={region}
          defaultRect={startingRect}
          onChange={handleChange}
          tint={TINT[mark]}
        />
      </div>

      <CutoutPreview sessionId={sessionId} mark={mark} region={region} enabled />

      {error && <ErrorBanner message={error} />}

      <div className="mt-6 flex flex-col gap-2.5">
        <Button onClick={() => void confirm()} loading={submit.isPending} disabled={!region}>
          {state.remaining.length > 0 ? 'Élément suivant' : 'Valider'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setRegion(null);
            setResetToken((n) => n + 1);
          }}
        >
          Réinitialiser le cadre
        </Button>
      </div>
    </Screen>
  );
};
