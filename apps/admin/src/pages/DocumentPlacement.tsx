import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ZONE_TYPE_LABEL, type NormalizedRect } from '@scansign/shared';
import {
  useAdjustPlacement,
  useDocument,
  useDocumentPlacement,
  useResetPlacement,
  useSignedPdfUrl,
} from '../lib/queries';
import { PdfViewer, type RenderedPage } from '../components/PdfViewer';
import { ZoneEditor, type EditorZone } from '../components/ZoneEditor';
import { Page } from '../components/Layout';
import { Button, Card, Spinner } from '../components/ui';

/**
 * Reposition the marks on a document that is already signed.
 *
 * The editor sits on top of the SIGNED PDF, not the original, because that is
 * the only view where the operator can see the problem they came to fix — a
 * signature crossing a printed line, or too small for the box it was meant for.
 * Judging a new position against a blank original would be guesswork.
 *
 * Saving does not edit that PDF. It re-runs the generator from the original
 * plus the stored cutout, so the signature is the same one, at the same
 * variant, in a new place. The document keeps its URL, so links already sent
 * still resolve to the current version.
 */
export const DocumentPlacementPage = () => {
  const { id } = useParams<{ id: string }>();

  const { data: doc, isLoading: loadingDoc } = useDocument(id);
  const { data: placement, isLoading: loadingPlacement } = useDocumentPlacement(id);
  const { data: pdf } = useSignedPdfUrl(id);

  const adjust = useAdjustPlacement();
  const reset = useResetPlacement();

  const [zones, setZones] = useState<EditorZone[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editor once the server says where the marks are.
  useEffect(() => {
    if (!placement) return;
    setZones(
      placement.zones.map((zone, i) => ({
        key: `zone-${i}`,
        page: zone.page,
        type: zone.type,
        rect: zone.rect,
      })),
    );
  }, [placement]);

  const dirty = useMemo(() => {
    if (!placement) return false;
    if (placement.zones.length !== zones.length) return true;
    return placement.zones.some((original, i) => {
      const current = zones[i];
      if (!current) return true;
      const a = original.rect;
      const b = current.rect;
      // Sub-pixel differences are float noise from the drag, not an edit.
      return (
        original.page !== current.page ||
        original.type !== current.type ||
        Math.abs(a.x - b.x) > 1e-6 ||
        Math.abs(a.y - b.y) > 1e-6 ||
        Math.abs(a.width - b.width) > 1e-6 ||
        Math.abs(a.height - b.height) > 1e-6
      );
    });
  }, [placement, zones]);

  const blocked = placement?.blockedReason ?? null;

  const save = async () => {
    if (!id) return;
    setError(null);
    setSaved(false);
    try {
      await adjust.mutateAsync({
        documentId: id,
        zones: zones.map((zone, index) => ({
          page: zone.page,
          type: zone.type,
          rect: zone.rect,
          index,
        })),
      });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Le repositionnement a échoué.');
    }
  };

  const restore = async () => {
    if (!id) return;
    setError(null);
    setSaved(false);
    try {
      await reset.mutateAsync(id);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'La restauration a échoué.');
    }
  };

  if (loadingDoc || loadingPlacement) {
    return (
      <Page title="Signature">
        <Spinner />
      </Page>
    );
  }

  return (
    <Page
      title={doc?.filename ?? 'Document'}
      description="Déplacez ou redimensionnez la signature sur le document signé. La signature elle-même n’est pas modifiée."
      actions={
        <>
          {doc?.folderId && (
            <Link to={`/folders/${doc.folderId}`}>
              <Button variant="ghost">Retour au dossier</Button>
            </Link>
          )}
          {placement?.source === 'document' && (
            <Button variant="secondary" onClick={() => void restore()} loading={reset.isPending}>
              Replacer selon le template
            </Button>
          )}
          <Button onClick={() => void save()} loading={adjust.isPending} disabled={!dirty || !!blocked}>
            Enregistrer
          </Button>
        </>
      }
    >
      {blocked && (
        <Card className="mb-4 border-l-4 border-l-amber-500 p-4">
          <p className="text-sm text-ink-700">{blocked}</p>
        </Card>
      )}

      {error && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-ink-700">{error}</p>
        </Card>
      )}

      {saved && !dirty && (
        <Card className="mb-4 border-l-4 border-l-emerald-500 p-4">
          <p className="text-sm text-ink-700">
            Document régénéré. Le PDF signé conserve la même adresse, les liens déjà transmis
            restent valides.
          </p>
        </Card>
      )}

      <Card className="mb-4 p-4">
        <p className="text-xs text-ink-500">
          {placement?.source === 'document'
            ? 'Ce document a un placement qui lui est propre : modifier le template ne le déplacera plus.'
            : 'Ce document suit le placement de son template. Dès que vous enregistrez, il garde le sien.'}
        </p>
        {zones.length > 0 && (
          <p className="mt-2 text-xs text-ink-400">
            {zones.map((z) => ZONE_TYPE_LABEL[z.type]).join(' · ')} — glissez pour déplacer, tirez
            un coin pour redimensionner.
          </p>
        )}
      </Card>

      {pdf?.url ? (
        <PdfViewer
          url={pdf.url}
          renderOverlay={(size: RenderedPage) => (
            <ZoneEditor
              width={size.width}
              height={size.height}
              page={size.page}
              zones={zones}
              // No drawing on this screen: the marks that exist are the marks
              // that were signed. Adding a zone here would ask the generator to
              // stamp ink nobody captured for it.
              drawing={null}
              onDrawn={() => undefined}
              onChange={(key: string, rect: NormalizedRect) =>
                setZones((current) =>
                  current.map((zone) => (zone.key === key ? { ...zone, rect } : zone)),
                )
              }
              onSelect={setSelected}
              selectedKey={selected}
            />
          )}
        />
      ) : (
        <Card className="p-6">
          <p className="text-sm text-ink-500">Chargement du document signé…</p>
        </Card>
      )}
    </Page>
  );
};
