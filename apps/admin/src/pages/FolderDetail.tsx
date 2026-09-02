import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Document } from '@scansign/shared';
import {
  downloadFinalPdf,
  finalPdfUrl,
  useAssignTemplate,
  useDeleteDocument,
  useFolder,
  useTemplates,
} from '../lib/queries';
import { api, ApiRequestError } from '../lib/api';
import { Page } from '../components/Layout';
import { ShareLinkPanel } from '../components/ShareLinkPanel';
import { PhoneHandoff } from '../components/PhoneHandoff';
import { ReturnsPanel } from '../components/ReturnsPanel';
import { ImportDialog } from '../components/ImportDialog';
import { PdfViewer } from '../components/PdfViewer';
import {
  Button,
  Card,
  DocumentStatusPill,
  ErrorNote,
  FolderStatusPill,
  Modal,
  Select,
  Spinner,
  folderReference,
  formatDate,
  timeAgo,
} from '../components/ui';

const humanSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.round(bytes / 1024)} ko`;

export const FolderDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const { data: folder, isLoading } = useFolder(id);
  const { data: templates } = useTemplates();
  const removeDocument = useDeleteDocument();
  /**
   * Documents ticked for comparison.
   *
   * Kept here rather than in the comparison screen so the choice is made where
   * the documents are listed, with their names and statuses in view — which is
   * the only place an operator can tell which two of four look wrong.
   */
  const [compare, setCompare] = useState<string[]>([]);
  const assign = useAssignTemplate();

  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<Document | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [previewing, setPreviewing] = useState<string | null>(null);
  /**
   * Signed document open in the reader.
   *
   * The signed URL is resolved once, when the button is pressed, and held here
   * for as long as the dialog stays open — re-resolving it on every render
   * would restart pdf.js and blank the page mid-scroll.
   */
  const [signedView, setSignedView] = useState<{
    id: string;
    url: string;
    filename: string;
  } | null>(null);
  const [openingSigned, setOpeningSigned] = useState<string | null>(null);

  /** Open the signed PDF on screen, before anyone downloads or sends it. */
  const viewSignedPdf = async (documentId: string) => {
    setOpeningSigned(documentId);
    setError(null);
    try {
      const { url, filename } = await finalPdfUrl(documentId);
      setSignedView({ id: documentId, url, filename });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'PDF signé indisponible.');
    } finally {
      setOpeningSigned(null);
    }
  };

  /** Open the document with its zones drawn on it — the placement proof. */
  const previewZones = async (documentId: string) => {
    setPreviewing(documentId);
    setError(null);
    try {
      const { url, annotated } = await api<{ url: string; annotated: boolean }>(
        `/documents/${documentId}/preview-url`,
      );
      if (!annotated) {
        setError("Ce document n'a pas encore de zones à afficher.");
        return;
      }
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Aperçu indisponible.');
    } finally {
      setPreviewing(null);
    }
  };

  if (isLoading || !folder) return <Spinner />;

  const all = folder.documents ?? [];
  /**
   * Contracts and capture sheets are listed apart.
   *
   * They are both PDFs in the same folder but they play opposite roles — one
   * receives the marks, the other is where the marks come from — and a single
   * list invites the operator to configure zones on a sheet that will never
   * have any.
   */
  const documents = all.filter((d) => d.role !== 'for_signing');
  const sheets = all.filter((d) => d.role === 'for_signing');
  const unconfigured = documents.filter((d) => d.status === 'awaiting_template');

  return (
    <Page
      title={folder.name}
      description={`DOSSIER ${folderReference(folder.reference)} · créé le ${formatDate(folder.createdAt)}`}
      actions={
        <>
          <Button variant="secondary" onClick={() => setImporting(true)}>
            Importer des PDF
          </Button>
          <PhoneHandoff folderId={folder.id} />
        </>
      }
    >
      <ImportDialog folderId={folder.id} open={importing} onClose={() => setImporting(false)} />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <FolderStatusPill status={folder.status} />
      </div>

      {folder.errorCode && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm font-medium text-red-700">Le traitement a échoué</p>
          <ErrorNote code={folder.errorCode} message={folder.errorMessage} />
        </Card>
      )}

      {error && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      <ReturnsPanel folderId={folder.id} />

      <ShareLinkPanel folderId={folder.id} documents={sheets} />

      {unconfigured.length > 0 && (
        <Card className="mb-4 border-l-4 border-l-amber-500 p-4">
          <p className="text-sm font-medium text-amber-800">
            {unconfigured.length} document(s) nécessitent une configuration de signature
          </p>
          <p className="mt-1 text-sm text-ink-600">
            Créez un template pour indiquer où placer la signature et le tampon, ou associez un
            template existant.
          </p>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200/70 px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Documents à faire signer</h2>
            {documents.length > 1 && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-500">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                  checked={compare.length === documents.length && documents.length > 0}
                  onChange={(e) =>
                    setCompare(e.target.checked ? documents.map((d) => d.id) : [])
                  }
                />
                Tout sélectionner
              </label>
            )}
          </div>

          {/* Variation between documents is deliberate — a folder signed by
              hand does not repeat itself — but that is a claim about what ends
              up on a contract, and it should be checkable by looking. Two
              documents is the minimum that can be compared, so the button
              appears only once two are ticked. */}
          {/* Always reachable once there are two documents: gating it behind a
              selection made it invisible to anyone who had not noticed the
              checkboxes. With nothing ticked it compares the whole folder. */}
          {documents.length >= 2 && (
            <Link
              to={`/folders/${folder.id}/comparer${
                compare.length >= 2 ? `?docs=${compare.join(',')}` : ''
              }`}
            >
              <Button variant="secondary">
                {compare.length >= 2
                  ? `Comparer ${compare.length} documents`
                  : 'Comparer les signatures'}
              </Button>
            </Link>
          )}
        </div>
        {documents.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-400">
            Aucun document à faire signer. Importez un PDF et choisissez « un document à faire
            signer ».
          </p>
        ) : (
          <ul className="divide-y divide-ink-200/70">
            {documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <input
                  type="checkbox"
                  aria-label={`Comparer ${doc.filename}`}
                  className="h-4 w-4 shrink-0 rounded border-ink-300 accent-brand-600"
                  checked={compare.includes(doc.id)}
                  onChange={(e) =>
                    setCompare((current) =>
                      e.target.checked
                        ? [...current, doc.id]
                        : current.filter((id) => id !== doc.id),
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{doc.filename}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {doc.pageCount} page(s) · {humanSize(doc.byteSize)}
                    {doc.template ? ` · template « ${doc.template.name} »` : ' · aucun template'}
                  </p>
                  <ErrorNote code={doc.errorCode} message={doc.errorMessage} />
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <DocumentStatusPill status={doc.status} />
                  <span className="text-[11px] text-ink-400" title={formatDate(doc.signedAt ?? doc.createdAt)}>
                    {doc.status === 'completed' && doc.signedAt
                      ? `signé ${timeAgo(doc.signedAt)}`
                      : `importé ${timeAgo(doc.createdAt)}`}
                  </span>
                </div>
                {doc.status === 'completed' ? (
                  <>
                    {/* Signing is not the end of the story. A signature that
                        landed on a printed line, or came out too small for the
                        box, used to mean re-signing the whole folder — the only
                        alternative was editing the template, which moves the
                        mark on every document it describes. Adjusting here
                        re-stamps THIS document with the same signature. */}
                    <Link to={`/documents/${doc.id}/placement`}>
                      <Button variant="secondary">Modifier la signature</Button>
                    </Link>
                    {/* Checking the stamp used to mean downloading the file
                        and opening it elsewhere. Reading it here keeps the
                        decision — send it, or re-place the signature — in the
                        screen that offers both. */}
                    <Button
                      variant="secondary"
                      loading={openingSigned === doc.id}
                      onClick={() => void viewSignedPdf(doc.id)}
                    >
                      Voir le PDF signé
                    </Button>
                    <Button variant="secondary" onClick={() => void downloadFinalPdf(doc.id)}>
                      Télécharger le PDF signé
                    </Button>
                    <Button
                      variant="danger"
                      loading={removeDocument.isPending && removeDocument.variables === doc.id}
                      onClick={() => {
                        if (window.confirm(`Supprimer « ${doc.filename} » et son PDF signé ?`)) {
                          removeDocument.mutate(doc.id);
                        }
                      }}
                    >
                      Supprimer
                    </Button>
                  </>
                ) : doc.status === 'awaiting_template' ? (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setConfiguring(doc);
                        setTemplateId(templates?.items[0]?.id ?? '');
                      }}
                      disabled={(templates?.items.length ?? 0) === 0}
                    >
                      Associer un template
                    </Button>
                    <Link to={`/templates/new?documentId=${doc.id}`}>
                      <Button>Configurer les zones</Button>
                    </Link>
                  </>
                ) : (
                  <>
                    {/* Zones stay reachable for as long as they still matter —
                        that is, until the document is signed. A document that
                        matched a template by hash never passes through
                        'awaiting_template', so gating these behind that status
                        left no way at all to review the placement. */}
                    <Button
                      variant="secondary"
                      loading={previewing === doc.id}
                      onClick={() => void previewZones(doc.id)}
                    >
                      Voir les zones
                    </Button>
                    {doc.templateId && (
                      <Link to={`/templates/${doc.templateId}?documentId=${doc.id}`}>
                        <Button variant="secondary">Modifier les zones</Button>
                      </Link>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setConfiguring(doc);
                        setTemplateId(doc.templateId ?? templates?.items[0]?.id ?? '');
                      }}
                      disabled={(templates?.items.length ?? 0) === 0}
                    >
                      Changer de template
                    </Button>
                    <Button
                      variant="danger"
                      loading={removeDocument.isPending && removeDocument.variables === doc.id}
                      onClick={() => {
                        if (window.confirm(`Supprimer « ${doc.filename} » ?`)) removeDocument.mutate(doc.id);
                      }}
                    >
                      Supprimer
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={signedView !== null}
        size="wide"
        title={signedView ? `PDF signé — ${signedView.filename}` : 'PDF signé'}
        onClose={() => setSignedView(null)}
        actions={
          signedView && (
            <Button variant="secondary" onClick={() => void downloadFinalPdf(signedView.id)}>
              Télécharger
            </Button>
          )
        }
      >
        {signedView && <PdfViewer url={signedView.url} maxWidth={860} />}
      </Modal>

      <Modal
        open={configuring !== null}
        title="Associer un template"
        onClose={() => setConfiguring(null)}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Choisissez le template décrivant « {configuring?.filename} ». Le système retiendra
            l’empreinte du fichier pour les prochains envois.
          </p>
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} label="Template">
            {(templates?.items ?? []).map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} ({template.zones?.length ?? 0} zone(s))
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfiguring(null)}>
              Annuler
            </Button>
            <Button
              loading={assign.isPending}
              onClick={() => {
                if (!configuring || !templateId) return;
                setError(null);
                assign.mutate(
                  { documentId: configuring.id, templateId },
                  {
                    onSuccess: () => setConfiguring(null),
                    onError: (e) =>
                      setError(e instanceof ApiRequestError ? e.message : 'Association impossible.'),
                  },
                );
              }}
            >
              Associer
            </Button>
          </div>
        </div>
      </Modal>
    </Page>
  );
};
