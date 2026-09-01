import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ZONE_TYPE,
  ZONE_TYPE_LABEL,
  type Document,
  type SaveTemplateInput,
  type ZoneType,
} from '@scansign/shared';
import { api, ApiRequestError } from '../lib/api';
import {
  downloadTemplatePdf,
  fetchOriginalUrl,
  fetchTemplateSource,
  useAssignTemplate,
  useSaveTemplate,
  useTemplate,
} from '../lib/queries';
import { Page } from '../components/Layout';
import { PdfViewer } from '../components/PdfViewer';
import { ZoneEditor, type EditorZone } from '../components/ZoneEditor';
import { Button, Card, Field, Spinner } from '../components/ui';

const newKey = () => Math.random().toString(36).slice(2, 10);

/**
 * Place signature and stamp zones directly on the PDF.
 *
 * Zones are stored as normalized 0..1 rectangles relative to the rendered
 * page, so they survive any screen size, zoom level or DPI, and are converted
 * to PDF points only at generation time.
 */
export const TemplateEditorPage = () => {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const documentId = params.get('documentId');

  const { data: template, isLoading: loadingTemplate } = useTemplate(id);
  const save = useSaveTemplate();
  const assign = useAssignTemplate();

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [sourceDocument, setSourceDocument] = useState<Document | null>(null);
  const [name, setName] = useState('');
  const [filenamePattern, setFilenamePattern] = useState('');
  const [zones, setZones] = useState<EditorZone[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [drawing, setDrawing] = useState<ZoneType | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [downloading, setDownloading] = useState(false);
  // Configuring zones for one document should not automatically add an entry to
  // the template library. Reusable is opt-in, and it is what makes the next
  // upload of the same file match automatically.
  const [reusable, setReusable] = useState(!documentId);

  /** Only meaningful once the template exists server-side. */
  const download = async () => {
    if (isNew || !id) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadTemplatePdf(id);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Téléchargement impossible.');
    } finally {
      setDownloading(false);
    }
  };

  /**
   * Load the PDF to draw on, in order of specificity:
   *   1. the document we were sent here to configure;
   *   2. the template's own source PDF, for a template created on its own;
   *   3. (inside source-url) a document already using the template.
   */
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoadingPdf(true);
      setError(null);
      try {
        if (documentId) {
          const doc = await api<Document>(`/documents/${documentId}`);
          const { url } = await fetchOriginalUrl(documentId);
          if (cancelled) return;
          setSourceDocument(doc);
          setPdfUrl(url);
          setPageCount(doc.pageCount);
          return;
        }

        if (!isNew && id) {
          const source = await fetchTemplateSource(id);
          if (cancelled) return;
          setPdfUrl(source.url);
          if (source.pageCount) setPageCount(source.pageCount);
          return;
        }

        setError(
          'Aucun document à afficher. Créez le template depuis la page Templates, ou ouvrez-le depuis un document.',
        );
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Chargement impossible.');
        }
      } finally {
        if (!cancelled) setLoadingPdf(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [documentId, id, isNew]);

  // Seed the form once the template (edit mode) or the document (create mode) lands.
  useEffect(() => {
    if (template) {
      setName(template.name);
      setFilenamePattern(template.filenamePattern ?? '');
      setZones(
        (template.zones ?? []).map((z) => ({
          key: newKey(),
          page: z.page,
          type: z.type,
          rect: z.rect,
        })),
      );
      setReusable(template.reusable);
    } else if (isNew && sourceDocument && name === '') {
      setName(sourceDocument.filename.replace(/\.pdf$/i, ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, sourceDocument, isNew]);

  const handlePageCount = useCallback((count: number) => setPageCount(count), []);

  const addZone = (rect: EditorZone['rect'], type: ZoneType, page: number) => {
    const key = newKey();
    setZones((prev) => [...prev, { key, page, type, rect }]);
    setSelectedKey(key);
    setDrawing(null);
  };

  const updateZone = (key: string, rect: EditorZone['rect']) =>
    setZones((prev) => prev.map((z) => (z.key === key ? { ...z, rect } : z)));

  const removeZone = (key: string) => {
    setZones((prev) => prev.filter((z) => z.key !== key));
    setSelectedKey(null);
  };

  const counts = useMemo(
    () =>
      ZONE_TYPE.reduce<Record<ZoneType, number>>(
        (acc, type) => ({ ...acc, [type]: zones.filter((z) => z.type === type).length }),
        // Seeded from the list itself: a hand-written literal silently missed
        // every type added later.
        Object.fromEntries(ZONE_TYPE.map((t) => [t, 0])) as Record<ZoneType, number>,
      ),
    [zones],
  );

  const handleSave = () => {
    if (zones.length === 0) {
      setError('Ajoutez au moins une zone de signature avant d’enregistrer.');
      return;
    }
    setError(null);

    const input: SaveTemplateInput = {
      reusable,
      name,
      documentHash: sourceDocument?.documentHash ?? template?.documentHash ?? null,
      filenamePattern: filenamePattern.trim() || null,
      pageCount: sourceDocument?.pageCount ?? template?.pageCount ?? pageCount,
      zones: zones
        .slice()
        .sort((a, b) => a.page - b.page)
        .map((zone, index) => ({ page: zone.page, type: zone.type, rect: zone.rect, index })),
    };

    save.mutate(
      { id: isNew ? undefined : id, input },
      {
        onSuccess: (saved) => {
          // Coming from an unconfigured document: wire it up straight away, so
          // the operator lands back on a folder that is ready to send.
          if (documentId) {
            assign.mutate(
              { documentId, templateId: saved.id },
              {
                onSuccess: () => navigate(`/folders/${sourceDocument?.folderId ?? ''}`),
                onError: (e) =>
                  setError(e instanceof ApiRequestError ? e.message : 'Association impossible.'),
              },
            );
          } else {
            navigate('/templates');
          }
        },
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Enregistrement impossible.'),
      },
    );
  };

  if (loadingTemplate || loadingPdf) return <Spinner />;

  return (
    <Page
      title={isNew ? 'Nouveau template' : 'Modifier le template'}
      description="Placez les zones directement sur le document. Les coordonnées sont enregistrées en valeurs relatives, indépendantes de l’écran."
      actions={
        <>
          {!isNew && (
            <Button variant="secondary" loading={downloading} onClick={() => void download()}>
              Télécharger le PDF
            </Button>
          )}
          <Button variant="secondary" onClick={() => navigate(-1)}>
            Annuler
          </Button>
          <Button onClick={handleSave} loading={save.isPending || assign.isPending}>
            Enregistrer
          </Button>
        </>
      }
    >
      {error && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div>
          <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 bg-ink-50/95 py-2 backdrop-blur">
            {ZONE_TYPE.map((type) => (
              <Button
                key={type}
                variant={drawing === type ? 'primary' : 'secondary'}
                onClick={() => setDrawing(drawing === type ? null : type)}
              >
                + {ZONE_TYPE_LABEL[type]}
              </Button>
            ))}
            {drawing ? (
              <span className="text-xs text-ink-400">
                Tracez un rectangle sur la page voulue.
              </span>
            ) : (
              <span className="text-xs text-ink-400">
                {pageCount} page{pageCount > 1 ? 's' : ''} · faites défiler pour toutes les voir
              </span>
            )}
          </div>

          {pdfUrl ? (
            <PdfViewer
              url={pdfUrl}
              maxWidth={700}
              onPageCount={handlePageCount}
              renderOverlay={(size) => (
                <ZoneEditor
                  width={size.width}
                  height={size.height}
                  page={size.page}
                  zones={zones}
                  drawing={drawing}
                  onDrawn={(rect, type) => addZone(rect, type, size.page)}
                  onChange={updateZone}
                  onSelect={setSelectedKey}
                  selectedKey={selectedKey}
                />
              )}
            />
          ) : (
            <Card className="p-10 text-center text-sm text-ink-400">
              Aucun document à afficher.
            </Card>
          )}
        </div>

        {/* Sticky, so the zone list and the name field stay usable while
            scrolling a long document. */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Card className="space-y-4 p-4">
            <Field
              label="Nom du template"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contrat de vente SimpliCar"
              required
            />
            <Field
              label="Motif de nom de fichier"
              value={filenamePattern}
              onChange={(e) => setFilenamePattern(e.target.value)}
              placeholder="contrat-vente-*.pdf"
              hint="Facultatif. Utilisé seulement si l’empreinte du fichier ne correspond à rien."
            />
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={reusable}
                onChange={(e) => setReusable(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-ink-200 accent-brand-600"
              />
              <span>
                <span className="block text-sm font-medium text-ink-800">
                  Réutilisable pour d’autres documents
                </span>
                <span className="mt-0.5 block text-xs text-ink-400">
                  Coché, ce template apparaît dans la liste et s’appliquera automatiquement au
                  prochain import du même fichier. Décoché, il ne sert qu’à ce document.
                </span>
              </span>
            </label>
            {sourceDocument && (
              <p className="text-xs text-ink-400">
                Empreinte du document : {sourceDocument.documentHash.slice(0, 16)}… ·{' '}
                {sourceDocument.pageCount} page(s)
              </p>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between border-b border-ink-200/70 px-4 py-2.5">
              <h2 className="text-sm font-semibold">Zones</h2>
              <span className="text-xs text-ink-400">
                {ZONE_TYPE.filter((t) => counts[t] > 0)
                  .map((t) => `${counts[t]} ${ZONE_TYPE_LABEL[t].toLowerCase()}`)
                  .join(' · ') || 'aucune zone'}
              </span>
            </div>
            {zones.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-400">
                Aucune zone. Cliquez sur « + Signature » puis tracez un rectangle.
              </p>
            ) : (
              <ul className="divide-y divide-ink-200/70">
                {zones
                  .slice()
                  .sort((a, b) => a.page - b.page)
                  .map((zone) => (
                    <li
                      key={zone.key}
                      className={`flex items-center justify-between gap-2 px-4 py-2.5 ${
                        zone.key === selectedKey ? 'bg-brand-50' : ''
                      }`}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setSelectedKey(zone.key);
                          document
                            .querySelector(`[data-page="${zone.page}"]`)
                            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }}
                      >
                        <p className="text-sm font-medium">
                          {ZONE_TYPE_LABEL[zone.type]} · page {zone.page}
                        </p>
                        <p className="text-xs tabular-nums text-ink-400">
                          x {zone.rect.x.toFixed(3)} · y {zone.rect.y.toFixed(3)} ·{' '}
                          {zone.rect.width.toFixed(3)} × {zone.rect.height.toFixed(3)}
                        </p>
                      </button>
                      <Button variant="ghost" onClick={() => removeZone(zone.key)} aria-label="Supprimer">
                        ✕
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
};
