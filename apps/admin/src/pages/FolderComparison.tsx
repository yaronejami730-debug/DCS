import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useFolder, useFolderComparison } from '../lib/queries';
import { SignatureOverlay, type OverlayLayer } from '../components/SignatureOverlay';
import { Page } from '../components/Layout';
import { Button, Card, EmptyState, Spinner } from '../components/ui';

const RED: [number, number, number] = [220, 38, 38];
const BLUE: [number, number, number] = [37, 99, 235];

/**
 * Two signatures from a folder, compared.
 *
 * Deliberately just that. An earlier version stacked every document's full PDF
 * in columns beside the marks, and the pages crowded out the one thing the
 * screen exists for — whole contracts are not what anybody is reading here.
 * Document A on the left, document B on the right, the two superimposed below.
 *
 * Each mark is isolated by subtracting the original page from the signed one,
 * so what is shown is exactly the ink the generator added: no printed caption,
 * no rules, no surrounding text. Both are then framed by their own ink, which
 * is what makes A, B and the overlay directly comparable even when the zones
 * they were stamped into differ in size and proportion.
 */
export const FolderComparisonPage = () => {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const { data: folder } = useFolder(id);
  const { data, isLoading } = useFolderComparison(id);

  const [pair, setPair] = useState<[string, string] | null>(null);

  /** Documents that actually carry a mark to compare. */
  const signedItems = useMemo(() => {
    const wanted = (params.get('docs') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const items = (data?.items ?? []).filter((item) => item.signed && item.zones.length > 0);
    return wanted.length > 0 ? items.filter((item) => wanted.includes(item.documentId)) : items;
  }, [data, params]);

  // Default to the first two, and re-seed when the selection changes under it.
  const effectivePair = useMemo<[string, string] | null>(() => {
    const ids = signedItems.map((i) => i.documentId);
    if (pair && ids.includes(pair[0]) && ids.includes(pair[1]) && pair[0] !== pair[1]) return pair;
    return ids.length >= 2 ? [ids[0]!, ids[1]!] : null;
  }, [pair, signedItems]);

  /**
   * The two layers, on a mark type both documents share.
   *
   * A signature laid over a "Lu et approuvé" is only a mess, and would suggest
   * a difference that means nothing.
   */
  const layers = useMemo<OverlayLayer[]>(() => {
    if (!effectivePair) return [];
    const chosen = effectivePair
      .map((docId) => signedItems.find((item) => item.documentId === docId))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (chosen.length !== 2) return [];

    const type =
      chosen[0]!.zones.find((z) => chosen[1]!.zones.some((o) => o.type === z.type))?.type ?? null;
    if (!type) return [];

    return chosen.map((item, i) => {
      const zone = item.zones.find((z) => z.type === type)!;
      return {
        label: `${item.filename} · variante ${item.variantIndex}`,
        url: item.url,
        originalUrl: item.originalUrl,
        page: zone.page,
        rect: zone.rect,
        colour: i === 0 ? RED : BLUE,
      };
    });
  }, [effectivePair, signedItems]);

  if (isLoading) {
    return (
      <Page title="Comparer">
        <Spinner />
      </Page>
    );
  }

  const picker = (slot: 0 | 1) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink-500">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm"
          style={{ background: `rgb(${(slot === 0 ? RED : BLUE).join(',')})` }}
        />
        Document {slot === 0 ? 'A' : 'B'}
      </span>
      <select
        className="w-full rounded-md border border-ink-200 bg-white px-2 py-1.5 text-sm"
        value={effectivePair?.[slot] ?? ''}
        onChange={(e) => {
          const other = effectivePair?.[slot === 0 ? 1 : 0];
          const next = e.target.value;
          if (!other || next === other) return;
          setPair(slot === 0 ? [next, other] : [other, next]);
        }}
      >
        {signedItems.map((item) => (
          <option key={item.documentId} value={item.documentId}>
            {item.filename} · variante {item.variantIndex}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Page
      title={`Comparer — ${folder?.name ?? 'dossier'}`}
      description="Deux signatures du dossier, isolées de leur page. Une même main se ressemble sans se répéter."
      actions={
        <Link to={`/folders/${id}`}>
          <Button variant="ghost">Retour au dossier</Button>
        </Link>
      }
    >
      {signedItems.length < 2 ? (
        <Card>
          <EmptyState
            title="Rien à comparer"
            description="Il faut au moins deux documents signés dans ce dossier."
            action={
              <Link to={`/folders/${id}`}>
                <Button>Retour au dossier</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-end gap-4">
              {picker(0)}
              {picker(1)}
            </div>
          </Card>

          {layers.length !== 2 ? (
            <Card className="p-4">
              <p className="text-sm text-ink-600">
                Ces deux documents ne portent pas le même type de marque : il n’y a rien de
                comparable entre eux.
              </p>
            </Card>
          ) : (
            <>
              <div className="mb-4 grid gap-4 md:grid-cols-2">
                {layers.map((layer, i) => (
                  <Card key={layer.label} className="p-4">
                    <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ background: `rgb(${layer.colour.join(',')})` }}
                      />
                      Document {i === 0 ? 'A' : 'B'}
                    </h2>
                    {/* Real size and real position: half of what tells two
                        signings apart, and normalising it away is why this
                        screen used to show none of it. */}
                    <SignatureOverlay layers={[layer]} width={520} align="zone" />
                  </Card>
                ))}
              </div>

              <Card className="p-4">
                <h2 className="text-sm font-semibold">Superposition</h2>
                <p className="mb-3 mt-0.5 text-xs text-ink-500">
                  Les deux signatures ramenées à la même taille et l’une sur l’autre, pour
                  comparer le tracé seul. Les différences de taille et de position, elles, se
                  voient sur les deux vues ci-dessus.
                </p>
                <SignatureOverlay layers={layers} width={860} />
              </Card>
            </>
          )}
        </>
      )}
    </Page>
  );
};
