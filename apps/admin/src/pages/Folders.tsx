import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCreateFolder, useDeleteFolder, useFolders } from '../lib/queries';
import { Page } from '../components/Layout';
import {
  Button,
  Card,
  EmptyState,
  Field,
  FolderStatusPill,
  Modal,
  Spinner,
  folderReference,
  formatDate,
} from '../components/ui';

export const FoldersPage = () => {
  const { data, isLoading } = useFolders();
  const create = useCreateFolder();
  const remove = useDeleteFolder();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name },
      {
        onSuccess: (folder) => {
          setCreating(false);
          setName('');
          navigate(`/folders/${folder.id}`);
        },
      },
    );
  };

  return (
    <Page
      title="Dossiers"
      description="Un dossier regroupe les documents signés ensemble, par un même lien."
      actions={<Button onClick={() => setCreating(true)}>Nouveau dossier</Button>}
    >
      {isLoading ? (
        <Spinner />
      ) : (data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Aucun dossier"
            description="Créez un dossier, importez vos PDF, puis partagez un lien de signature."
            action={<Button onClick={() => setCreating(true)}>Nouveau dossier</Button>}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-200/70">
            {data!.items.map((folder) => (
              <li key={folder.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <Link to={`/folders/${folder.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium hover:text-brand-600">{folder.name}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    DOSSIER {folderReference(folder.reference)} · {folder.documents?.length ?? 0}{' '}
                    document(s)
                    {' · '}
                    {formatDate(folder.createdAt)}
                  </p>
                </Link>
                <FolderStatusPill status={folder.status} />
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`Supprimer « ${folder.name} » et ses documents ?`)) {
                      remove.mutate(folder.id);
                    }
                  }}
                >
                  Supprimer
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal open={creating} title="Nouveau dossier" onClose={() => setCreating(false)}>
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Nom du dossier"
            placeholder="Contrat véhicule ABC"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setCreating(false)}>
              Annuler
            </Button>
            <Button type="submit" loading={create.isPending}>
              Créer
            </Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
};
