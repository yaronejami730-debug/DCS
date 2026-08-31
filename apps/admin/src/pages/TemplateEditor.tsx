import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Document, SaveTemplateInput, ZoneType } from '@scansign/shared';
import { api, ApiRequestError } from '../lib/api';
import { fetchOriginalUrl, useAssignTemplate, useSaveTemplate, useTemplate } from '../lib/queries';
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
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [rendered, setRendered] = useState<{ width: number; height: number } | null>(null);
  const [drawing, setDrawing] = useState<ZoneType | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(true);

  // Load the PDF to draw on: the document we came from, or one already using
  // this template when re-opening an existing one.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoadingPdf(true);
      setError(null);
      try {
        let docId = documentId;
        if (!docId && !isNew && id) {
          const preview = await api<{ documentId: string }>(`/templates/${id}/preview-document`);
          docId = preview.documentId;
        }
        if (!docId) {
          setError(
            'Aucun document à afficher pour ce template. Ouvrez-le depuis un document dans un dossier.',
          );
          return;
        }
        const doc = await api<Document>(`/documents/${docId}`);
        const { url } = await fetchOriginalUrl(docId);
        if (cancelled) return;
        setSourceDocument(doc);
        setPdfUrl(url);
        setPageCount(doc.pageCount);
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
    } else if (isNew && sourceDocument && name === '') {
      setName(sourceDocument.filename.replace(/\.pdf$/i, ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, sourceDocument, isNew]);

  const handleRendered = useCallback((size: { width: number; height: number }) => {
    setRendered(size);
  }, []);
  const handlePageCount = useCallback((count: number) => setPageCount(count), []);

  const addZone = (rect: EditorZone['rect'], type: ZoneType) => {
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
    () => ({
      signature: zones.filter((z) => z.type === 'signature').length,
      stamp: zones.filter((z) => z.type === 'stamp').length,
    }),
    [zones],
  );

  const handleSave = () => {
    if (zones.length === 0) {
      setError('Ajoutez au moins une zone de signature avant d’enregistrer.');
      return;
    }
    setError(null);

    const input: SaveTemplateInput = {
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

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button
              variant={drawing === 'signature' ? 'primary' : 'secondary'}
              onClick={() => setDrawing(drawing === 'signature' ? null : 'signature')}
            >
              + Signature
            </Button>
            <Button
              variant={drawing === 'stamp' ? 'primary' : 'secondary'}
              onClick={() => setDrawing(drawing === 'stamp' ? null : 'stamp')}
            >
              + Tampon
            </Button>
            {drawing && (
              <span className="text-xs text-ink-400">
                Tracez un rectangle sur le document pour placer la zone.
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                ‹
              </Button>
              <span className="text-sm tabular-nums text-ink-600">
                Page {page} / {pageCount}
              </span>
              <Button
                variant="ghost"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={page >= pageCount}
              >
                ›
              </Button>
            </div>
          </div>

          {pdfUrl ? (
            <PdfViewer
              url={pdfUrl}
              page={page}
              onPageCount={handlePageCount}
              onRendered={handleRendered}
            >
              {rendered && (
                <ZoneEditor
                  width={rendered.width}
                  height={rendered.height}
                  page={page}
                  zones={zones}
                  drawing={drawing}
                  onDrawn={addZone}
                  onChange={updateZone}
                  onSelect={setSelectedKey}
                  selectedKey={selectedKey}
                />
              )}
            </PdfViewer>
          ) : (
            <Card className="p-10 text-center text-sm text-ink-400">
              Aucun document à afficher.
            </Card>
          )}
        </div>

        <div className="space-y-4">
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
                {counts.signature} signature · {counts.stamp} tampon
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
                          setPage(zone.page);
                          setSelectedKey(zone.key);
                        }}
                      >
                        <p className="text-sm font-medium">
                          {zone.type === 'signature' ? 'Signature' : 'Tampon'} · page {zone.page}
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
