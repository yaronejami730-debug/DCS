import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ERROR_CODE_LABEL, type ErrorCode } from '@scansign/shared';
import { useSession } from '../lib/queries';
import { Button, Screen, Spinner, Subtitle, Title } from '../components/ui';

/**
 * Waiting screen. The user never sees crops, providers or coordinates — only
 * "en cours", then "signé".
 *
 * The phone version buzzes on the outcome because the signer has usually looked
 * away by then. `navigator.vibrate` is the browser equivalent, and it is
 * missing on iOS Safari, so it is called defensively and nothing depends on it.
 */
const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* a browser that exposes the method but refuses the call */
  }
};

export const ProcessingPage = () => {
  const { token, sessionId } = useParams<{ token: string; sessionId: string }>();
  const navigate = useNavigate();
  const { data: session } = useSession(sessionId, true);

  const status = session?.status ?? 'processing';
  const failed = status === 'error';
  const done = status === 'completed';

  // Announced once, and from an effect: polling re-renders this screen every
  // 1.5s, so buzzing in the render body would rattle the phone continuously.
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current || (!done && !failed)) return;
    announced.current = true;
    buzz(done ? 40 : [60, 60, 60]);
  }, [done, failed]);

  return (
    <Screen className="items-center justify-center gap-2.5 px-8 text-center">
      {!done && !failed && (
        <>
          <Spinner className="h-8 w-8" />
          <Title>Traitement en cours…</Title>
          <Subtitle>Nous détourons votre signature et l’insérons dans vos documents.</Subtitle>
        </>
      )}

      {done && (
        <>
          <span className="text-6xl font-bold text-emerald-600">✓</span>
          <Title>Signature envoyée</Title>
          <Subtitle>
            Elle a été apposée sur les documents. Vous pouvez fermer cette page.
          </Subtitle>
        </>
      )}

      {failed && (
        <>
          <span className="text-6xl font-bold text-red-600">!</span>
          <Title>Le traitement a échoué</Title>
          <Subtitle>
            {ERROR_CODE_LABEL[session?.errorCode as ErrorCode] ??
              session?.errorMessage ??
              'Une erreur est survenue.'}
          </Subtitle>
          <Button onClick={() => navigate(`/s/${token}/photo`, { replace: true })} className="mt-7">
            Reprendre la photo
          </Button>
        </>
      )}
    </Screen>
  );
};
