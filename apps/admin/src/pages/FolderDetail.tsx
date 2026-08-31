import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Document } from '@scansign/shared';
import {
  downloadFinalPdf,
  useAssignTemplate,
  useDevices,
  useFolder,
  useSendFolder,
  useTemplates,
  useUploadDocuments,
} from '../lib/queries';
import { api, ApiRequestError } from '../lib/api';
import { Page } from '../components/Layout';
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
} from '../components/ui';

const humanSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.round(bytes / 1024)} ko`;

export const FolderDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const { data: folder, isLoading } = useFolder(id);
  const { data: devices } = useDevices();
  const { data: templates } = useTemplates();
  const upload = useUploadDocuments();
  const send = useSendFolder();
  const assign = useAssignTemplate();

  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [configuring, setConfiguring] = useState<Document | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [previewing, setPreviewing] = useState<string | null>(null);

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

  const documents = folder.documents ?? [];
  const unconfigured = documents.filter((d) => d.status === 'awaiting_template');
  const selectedDevice = deviceId || folder.deviceId || devices?.items[0]?.id || '';

  const handleUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    upload.mutate(
      { folderId: folder.id, files: Array.from(files) },
      { onError: (e) => setError(e instanceof ApiRequestError ? e.message : 'Import impossible.') },
    );
    if (fileInput.current) fileInput.current.value = '';
  };

  const handleSend = () => {
    if (!selectedDevice) {
      setError('Aucun appareil disponible. Connectez l’application sur un iPhone.');
      return;
    }
    setError(null);
    send.mutate(
      { folderId: folder.id, deviceId: selectedDevice },
      { onError: (e) => setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.') },
    );
  };

  return (
    <Page
      title={folder.name}
      description={`DOSSIER ${folderReference(folder.reference)} · créé le ${formatDate(folder.createdAt)}`}
      actions={
        <>
          <Button variant="secondary" onClick={() => fileInput.current?.click()} loading={upload.isPending}>
            Importer des PDF
          </Button>
          <Button onClick={handleSend} loading={send.isPending} disabled={documents.length === 0}>
            Envoyer à l’appareil
          </Button>
        </>
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf"
        multiple
        hidden
        onChange={(e) => handleUpload(e.target.files)}
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <FolderStatusPill status={folder.status} />
        {folder.device && <span className="text-sm text-ink-600">→ {folder.device.name}</span>}
        <div className="ml-auto w-56">
          <Select
            value={selectedDevice}
            onChange={(e) => setDeviceId(e.target.value)}
            aria-label="Appareil destinataire"
          >
            {(devices?.items ?? []).length === 0 && <option value="">Aucun appareil</option>}
            {(devices?.items ?? []).map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} {device.online ? '(en ligne)' : '(hors ligne)'}
              </option>
            ))}
          </Select>
        </div>
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
        <div className="border-b border-ink-200/70 px-5 py-3">
          <h2 className="text-sm font-semibold">Documents</h2>
        </div>
        {documents.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-400">
            Aucun document. Importez un ou plusieurs PDF.
          </p>
        ) : (
          <ul className="divide-y divide-ink-200/70">
            {documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{doc.filename}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {doc.pageCount} page(s) · {humanSize(doc.byteSize)}
                    {doc.template ? ` · template « ${doc.template.name} »` : ' · aucun template'}
                  </p>
                  <ErrorNote code={doc.errorCode} message={doc.errorMessage} />
                </div>
                <DocumentStatusPill status={doc.status} />
                {doc.status === 'completed' ? (
                  /* Signed and done: the zones were configuration, and the
                     only thing left to do with the document is take it. */
                  <Button variant="secondary" onClick={() => void downloadFinalPdf(doc.id)}>
                    Télécharger le PDF signé
                  </Button>
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
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

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
