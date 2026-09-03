import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ATTESTATION_SHEET_V1,
  ZONE_TYPE,
  ZONE_TYPE_LABEL,
  sheetFieldTargetsDocument,
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
import { Button, Card, Field, Select, Spinner } from '../components/ui';
import { zoneLabel } from '../lib/zoneLabel';

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
  /** The sheet box the zone being drawn is filled from, when a box button started it. */
  const [drawingSheet, setDrawingSheet] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [downloading, setDownloading] = useState(false);
  // Configuring zones for one document should not automatically add an entry to
  // the template library. Reusable is opt-in, and it is what makes the next
  // upload of the same file match automatically.
  const [reusable, setReusable] = useState(!documentId);
  /**
   * Which box of the capture sheet signs this template. '' = decided by the
   * keywords in the name, which is right for a template called "Devis".
   */
  const [sheetField, setSheetField] = useState('');
  /** The rarer zone types, folded away so the sheet's own marks lead. */
  const [showOtherTypes, setShowOtherTypes] = useState(false);

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
          sheetField: z.sheetField ?? null,
        })),
      );
      setReusable(template.reusable);
      setSheetField(template.sheetField ?? '');
    } else if (isNew && sourceDocument && name === '') {
      setName(sourceDocument.filename.replace(/\.pdf$/i, ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, sourceDocument, isNew]);

  const handlePageCount = useCallback((count: number) => setPageCount(count), []);

  const addZone = (rect: EditorZone['rect'], type: ZoneType, page: number) => {
    const key = newKey();
    const sheetField = type === 'signature' ? drawingSheet : null;
    setZones((prev) => [...prev, { key, page, type, rect, sheetField }]);
    setSelectedKey(key);
    setDrawing(null);
    setDrawingSheet(null);
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
      sheetField: sheetField || null,
      pageCount: sourceDocument?.pageCount ?? template?.pageCount ?? pageCount,
      zones: zones
        .slice()
        .sort((a, b) => a.page - b.page)
        .map((zone, index) => ({
          page: zone.page,
          type: zone.type,
          rect: zone.rect,
          index,
          sheetField: zone.sheetField ?? null,
        })),
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
          {(() => {
            /**
             * The toolbar speaks the sheet's language.
             *
             * The marks a template receives are the boxes of the capture sheet:
             * one signature (from the box its name, or its explicit choice,
             * designates), the mention, the manager's name, the quote date. Those
             * come first, named as on the sheet. The other zone types still
             * exist — a stamp, a plain date — behind « Autres zones ».
             */
            const signatureBoxes = ATTESTATION_SHEET_V1.fields.filter((f) => f.type === 'signature');
            const chosenBox =
              signatureBoxes.find((f) => f.id === sheetField) ??
              signatureBoxes.find((f) => sheetFieldTargetsDocument(f, [name]));
            const sheetButtons: Array<{ type: ZoneType; label: string }> = ATTESTATION_SHEET_V1.fields
              .filter((f) => f.type !== 'signature')
              .map((f) => ({ type: f.type, label: f.shortLabel }));
            const sheetTypes = new Set<ZoneType>(['signature', ...sheetButtons.map((b) => b.type)]);
            const otherTypes = ZONE_TYPE.filter((t) => !sheetTypes.has(t));
            const startSignature = (fieldId: string) => {
              if (drawing === 'signature' && drawingSheet === fieldId) {
                setDrawing(null);
                setDrawingSheet(null);
              } else {
                setDrawing('signature');
                setDrawingSheet(fieldId);
              }
            };
            return (
              <div className="sticky top-0 z-10 mb-3 bg-ink-50/95 py-2 backdrop-blur">
                {/*
                  One button per signature box of the sheet: "Signature repère 2"
                  draws a zone filled from that box. Pressed again for the same box,
                  the next zone is a variant of that signature — said in the
                  button's own label once a first zone exists.
                */}
                <div className="flex flex-wrap items-center gap-2">
                  {signatureBoxes.map((box, i) => {
                    const existing = zones.filter(
                      (z) => z.type === 'signature' && z.sheetField === box.id,
                    ).length;
                    const active = drawing === 'signature' && drawingSheet === box.id;
                    // Two buttons per box: the signature itself, then its
                    // variants. The base is placed once; a variant needs the
                    // base to exist, since it is a variant OF it.
                    return (
                      <span key={box.id} className="inline-flex gap-1">
                        <Button
                          variant={active && existing === 0 ? 'primary' : 'secondary'}
                          disabled={existing > 0}
                          onClick={() => startSignature(box.id)}
                          title={existing > 0 ? `${box.label} — déjà placée` : box.label}
                        >
                          + Signature repère {i + 1}
                        </Button>
                        <Button
                          variant={active && existing > 0 ? 'primary' : 'secondary'}
                          disabled={existing === 0}
                          onClick={() => startSignature(box.id)}
                          title={
                            existing === 0
                              ? `Placez d’abord « Signature repère ${i + 1} »`
                              : `Variante ${existing + 1} de la signature ${box.label}`
                          }
                        >
                          + Variante signature repère {i + 1}
                        </Button>
                      </span>
                    );
                  })}
                  {sheetButtons.map(({ type, label }) => (
                    <Button
                      key={type}
                      variant={drawing === type ? 'primary' : 'secondary'}
                      onClick={() => {
                        setDrawingSheet(null);
                        setDrawing(drawing === type ? null : type);
                      }}
                    >
                      + {label}
                    </Button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setShowOtherTypes((v) => !v)}
                    className="text-xs font-medium text-ink-500 hover:underline"
                  >
                    {showOtherTypes ? 'Masquer les autres zones' : 'Autres zones…'}
                  </button>
                  {showOtherTypes &&
                    [...otherTypes, 'signature' as ZoneType].map((type) => (
                      <Button
                        key={type}
                        variant={drawing === type && !drawingSheet ? 'primary' : 'secondary'}
                        onClick={() => {
                          setDrawingSheet(null);
                          setDrawing(drawing === type && !drawingSheet ? null : type);
                        }}
                      >
                        + {type === 'signature' ? 'Signature (sans repère)' : ZONE_TYPE_LABEL[type]}
                      </Button>
                    ))}
                </div>
                <p className="mt-1.5 text-xs text-ink-400">
                  {drawing ? (
                    drawing === 'stamp'
                      ? 'Cliquez à l’endroit du tampon : la zone se pose à la taille standard (45 mm), déplaçable mais pas redimensionnable.'
                      : drawing === 'signature' &&
                    drawingSheet &&
                    zones.some((z) => z.type === 'signature' && z.sheetField === drawingSheet)
                      ? 'Tracez la zone : cette signature supplémentaire recevra une variante différente de la même signature.'
                      : 'Tracez un rectangle sur la page voulue.'
                  ) : chosenBox ? (
                    <>
                      Signature reprise de la case <b className="text-ink-600">{chosenBox.label}</b>
                      {sheetField ? ' (choisie à droite)' : ' (d’après le nom du template)'} ·{' '}
                      {pageCount} page{pageCount > 1 ? 's' : ''}
                    </>
                  ) : (
                    <span className="text-amber-700">
                      Aucune case de la feuille ne correspond au nom « {name || '…'} » : choisissez-la
                      à droite pour que la signature arrive ici.
                    </span>
                  )}
                </p>
                {(() => {
                  /**
                   * The zone decides which box fills it — so a "Signature repère 2"
                   * drawn on a template whose name says "Devis" WILL receive the
                   * AH's signature. Legal, occasionally intended, usually a slip:
                   * say it, in orange, without blocking.
                   */
                  const expected = signatureBoxes.find((f) => sheetFieldTargetsDocument(f, [name]));
                  const strays = zones.filter(
                    (z) =>
                      z.type === 'signature' &&
                      z.sheetField &&
                      expected &&
                      z.sheetField !== expected.id,
                  );
                  if (!expected || strays.length === 0) return null;
                  const labels = Array.from(
                    new Set(
                      strays.map((z) => signatureBoxes.find((f) => f.id === z.sheetField)?.label ?? z.sheetField),
                    ),
                  );
                  return (
                    <p className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                      Attention : d’après son nom, ce template relève de la case{' '}
                      <b>{expected.label}</b>, mais {strays.length > 1 ? 'des zones' : 'une zone'} de
                      signature {strays.length > 1 ? 'visent' : 'vise'} {labels.join(' et ')}. La zone
                      l’emporte : elle recevra cette signature-là. Retracez-la avec le bon bouton si
                      ce n’est pas voulu.
                    </p>
                  );
                })()}
              </div>
            );
          })()}

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
            {(() => {
              const signatureBoxes = ATTESTATION_SHEET_V1.fields.filter(
                (f) => f.type === 'signature',
              );
              const guessed = signatureBoxes.find((f) => sheetFieldTargetsDocument(f, [name]));
              return (
                <div>
                  <Select
                    label="Case de signature sur la feuille"
                    value={sheetField}
                    onChange={(e) => setSheetField(e.target.value)}
                  >
                    <option value="">
                      {guessed
                        ? `Automatique — d’après le nom : ${guessed.label}`
                        : 'Automatique — d’après le nom du template'}
                    </option>
                    {signatureBoxes.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-ink-400">
                    Sur l’attestation simplifiée, chaque case de signature vise un groupe de
                    documents. Dites ici laquelle signe ce template si son nom ne le dit pas.
                  </p>
                </div>
              );
            })()}
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
                          {zoneLabel(zone, zones)} · page {zone.page}
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
