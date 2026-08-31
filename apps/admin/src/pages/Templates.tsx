import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  downloadTemplatePdf,
  useCreateTemplateFromPdf,
  useDeleteTemplate,
  useTemplates,
} from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { Page } from '../components/Layout';
import { Button, Card, EmptyState, Field, Modal, Spinner, formatDate } from '../components/ui';

export const TemplatesPage = () => {
  const { data, isLoading } = useTemplates();
  const remove = useDeleteTemplate();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const create = useCreateTemplateFromPdf();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Name it, give it the PDF it describes, then place the zones. */
  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setError(null);
    create.mutate(
      { name, file },
      {
        onSuccess: (template) => {
          setCreating(false);
          setName('');
          setFile(null);
          navigate(`/templates/${template.id}`);
        },
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Création impossible.'),
      },
    );
  };

  const download = async (id: string) => {
    setDownloading(id);
    setError(null);
    try {
      await downloadTemplatePdf(id);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Téléchargement impossible.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Page
      title="Templates"
      description="Un template décrit où placer la signature, le tampon et la mention dans un type de document."
      actions={<Button onClick={() => setCreating(true)}>Nouveau template</Button>}
    >
      {error && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      {isLoading ? (
        <Spinner />
      ) : (data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Aucun template"
            description="Créez-en un : donnez-lui un nom, ajoutez le PDF qu’il décrit, puis placez les zones."
            action={<Button onClick={() => setCreating(true)}>Nouveau template</Button>}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-200/70">
            {data!.items.map((template) => {
              const signatures = template.zones?.filter((z) => z.type === 'signature').length ?? 0;
              const stamps = template.zones?.filter((z) => z.type === 'stamp').length ?? 0;
              const mentions = template.zones?.filter((z) => z.type === 'mention').length ?? 0;
              const combined =
                template.zones?.filter((z) => z.type === 'signature_stamp').length ?? 0;
              return (
                <li key={template.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{template.name}</p>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {signatures} signature(s) · {stamps} tampon(s)
                      {mentions > 0 ? ` · ${mentions} mention(s)` : ''}
                      {combined > 0 ? ` · ${combined} tampon+signature` : ''}
                      {template.pageCount ? ` · ${template.pageCount} page(s)` : ''}
                      {template.documentHash ? ' · reconnu par empreinte' : ' · sans empreinte'} ·
                      modifié le {formatDate(template.updatedAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      loading={downloading === template.id}
                      onClick={() => void download(template.id)}
                    >
                      Télécharger le PDF
                    </Button>
                    <Link to={`/templates/${template.id}`}>
                      <Button variant="secondary">Ouvrir</Button>
                    </Link>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Supprimer le template « ${template.name} » ?`)) {
                          remove.mutate(template.id);
                        }
                      }}
                    >
                      Supprimer
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <Modal open={creating} title="Nouveau template" onClose={() => setCreating(false)}>
        <form onSubmit={submitNew} className="space-y-4">
          <Field
            label="Nom du template"
            placeholder="Devis"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            hint="Ce que décrit ce template : Devis, Contrat de vente, Mandat…"
          />

          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-800">Document modèle</span>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <Button variant="secondary" type="button" onClick={() => fileInput.current?.click()}>
              {file ? 'Changer de PDF' : 'Choisir un PDF'}
            </Button>
            {file && <p className="mt-2 text-xs text-ink-600">{file.name}</p>}
            <p className="mt-1 text-xs text-ink-400">
              Un exemplaire vierge du document. Vous placerez les zones dessus à l’étape suivante.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setCreating(false)}>
              Annuler
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!file || !name.trim()}>
              Continuer
            </Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
};
