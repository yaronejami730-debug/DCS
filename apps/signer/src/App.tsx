import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { setShareToken } from './lib/api';
import { Loading, Screen, Subtitle, Title } from './components/ui';
import { LandingPage } from './pages/Landing';
import { CapturePage } from './pages/Capture';
import { SelectRegionsPage } from './pages/SelectRegions';
import { FrameMarkPage } from './pages/FrameMark';
import { ProcessingPage } from './pages/Processing';

/**
 * pdf.js is bigger than the rest of this app put together, and only an operator
 * link ever opens a document. Splitting it out keeps the first load — which
 * happens on a phone, often on mobile data, before anyone has done anything —
 * down to what the capture flow actually uses.
 */
const DocumentPage = lazy(() =>
  import('./pages/Document').then((m) => ({ default: m.DocumentPage })),
);

/**
 * Everything under /s/:token runs with that token as its only credential.
 *
 * It is published into the api module here, once, at the top of the tree —
 * rather than threaded through every query — because `api()` is called from
 * query functions that are not components and have no access to context. The
 * effect runs before children fetch anything, and clears on unmount so a token
 * cannot outlive the route that carried it.
 */
const ShareScope = ({ children }: { children: React.ReactNode }) => {
  const { token } = useParams<{ token: string }>();

  // Layout-phase, not effect-phase: a child's query fires during its own first
  // render, which happens before any effect in this parent. Setting it in an
  // effect meant the first request of every session went out unauthenticated.
  setShareToken(token ?? null);

  useEffect(() => () => setShareToken(null), []);

  if (!token) return <Navigate to="/" replace />;
  return <>{children}</>;
};

/**
 * The address bar is the whole of this app's state, and there is nothing to
 * show at the root: without a token there is no request to answer.
 */
const NoLink = () => (
  <Screen className="items-center justify-center gap-3 px-8 text-center">
    <span className="text-5xl">🔗</span>
    <Title>Aucune demande</Title>
    <Subtitle>
      Ouvrez le lien de signature qui vous a été envoyé. Il ressemble à
      «&nbsp;…/s/xxxxxxxx&nbsp;».
    </Subtitle>
  </Screen>
);

export const App = () => (
  <Routes>
    <Route
      path="/s/:token/*"
      element={
        <ShareScope>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="photo" element={<CapturePage />} />
            <Route
              path="document/:id"
              element={
                <Suspense fallback={<Loading label="Ouverture du document…" />}>
                  <DocumentPage />
                </Suspense>
              }
            />
            <Route path="cadrer" element={<SelectRegionsPage />} />
            <Route path="marque/:mark" element={<FrameMarkPage />} />
            <Route path="traitement/:sessionId" element={<ProcessingPage />} />
            <Route path="*" element={<Navigate to="." replace />} />
          </Routes>
        </ShareScope>
      }
    />
    <Route path="*" element={<NoLink />} />
  </Routes>
);
