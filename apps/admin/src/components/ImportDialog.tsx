import { useEffect, useRef, useState } from 'react';
import type { DocumentRole } from '@scansign/shared';
import { useUploadDocuments } from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { Button, Modal } from './ui';
import { peekAttestationTemplate, takeAttestationTemplate } from '../lib/attestationTemplate';

/**
 * Where does this PDF go?
 *
 * The question is asked on every import, never guessed, because the two kinds
 * are indistinguishable as files and the cost of getting it wrong is asymmetric
 * and silent:
 *
 *   a contract filed as a capture sheet is never stamped — the operator finds
 *   out when the client asks where their signed contract is
 *
 *   a capture sheet filed as a contract merely sits in "à configurer", which is
 *   visible on the folder and takes one click to fix
 *
 * So the dialog defaults to nothing at all: picking is the point, and a
 * pre-selected radio is a decision made by the software on the operator's
 * behalf in exactly the place they should be making it themselves.
 */
export const ImportDialog = ({
  folderId,
  open,
  onClose,
}: {
  folderId: string;
  open: boolean;
  onClose: () => void;
}) => {
  const upload = useUploadDocuments();
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [role, setRole] = useState<DocumentRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [templateName, setTemplateName] = useState<string | null>(null);

  // A dialog reopened after an import must not still be holding the last one.
  useEffect(() => {
    if (open) {
      setFiles([]);
      setRole(null);
      setError(null);
      setTemplateName(peekAttestationTemplate()?.name ?? null);
    }
  }, [open]);

  const addTemplate = () => {
    const file = takeAttestationTemplate();
    if (!file) return;
    setFiles((prev) => [...prev, file]);
    setTemplateName(null);
  };

  const submit = () => {
    if (files.length === 0 || !role) return;
    setError(null);
    upload.mutate(
      { folderId, files, role },
      {
        onSuccess: onClose,
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Import impossible.'),
      },
    );
  };

  const choice = (
    value: DocumentRole,
    title: string,
    description: string,
    detail: string,
  ) => (
    <button
      type="button"
      onClick={() => setRole(value)}
      className={`w-full rounded-lg p-3.5 text-left ring-1 transition ${
        role === value ? 'bg-brand-50 ring-2 ring-brand-500' : 'ring-ink-200 hover:bg-ink-50'
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`h-4 w-4 shrink-0 rounded-full border-2 ${
            role === value ? 'border-brand-600 bg-brand-600' : 'border-ink-300'
          }`}
        />
        <span className="text-sm font-semibold">{title}</span>
      </span>
      <span className="mt-1.5 block pl-6 text-sm text-ink-600">{description}</span>
      <span className="mt-1 block pl-6 text-xs text-ink-400">{detail}</span>
    </button>
  );

  return (
    <Modal open={open} title="Importer des PDF" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => fileInput.current?.click()}>
              Choisir des fichiers
            </Button>
            {templateName && (
              <Button variant="secondary" onClick={addTemplate}>
                Utiliser l’attestation simplifiée
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            multiple
            hidden
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              // Let the same file be chosen twice in a row.
              e.target.value = '';
            }}
          />

          {files.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1">
              {files.map((file, i) => (
                <li
                  key={`${file.name}-${i}`}
                  className="flex items-center gap-2 text-sm text-ink-600"
                >
                  <span className="shrink-0">📄</span>
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-ink-400">
                    {Math.round(file.size / 1024)} ko
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {files.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink-800">
              {files.length > 1 ? 'Ces PDF sont :' : 'Ce PDF est :'}
            </p>

            {/*
              The technician's document comes first: the operator reached for
              "Importer" while thinking about the link, so the option that feeds
              the link is the one they are most often here for.
            */}
            {choice(
              'for_signing',
              'Un lien de signature',
              'Pour le technicien. Il l’imprime, le signe à la main, le photographie et vous le renvoie par le lien.',
              'Va dans « Liens de signature »',
            )}

            {choice(
              'to_sign',
              'Un document à faire signer',
              'Le contrat. Il rejoint les documents du dossier, vous y placez les zones, et la signature reçue viendra s’y apposer.',
              'Va dans « Documents à faire signer »',
            )}
          </div>
        )}

        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            loading={upload.isPending}
            disabled={files.length === 0 || !role}
            onClick={submit}
          >
            Importer
          </Button>
        </div>
      </div>
    </Modal>
  );
};
