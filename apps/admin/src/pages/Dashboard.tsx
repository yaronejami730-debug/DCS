import { Link } from 'react-router-dom';
import { useActivity, useDashboard, useFolders } from '../lib/queries';
import { Page } from '../components/Layout';
import { Card, FolderStatusPill, Spinner, folderReference, formatDate } from '../components/ui';

const Tile = ({
  label,
  value,
  tone = 'text-ink-900',
}: {
  label: string;
  value: number | undefined;
  tone?: string;
}) => (
  <Card className="p-5">
    <p className="text-sm text-ink-400">{label}</p>
    <p className={`mt-2 text-3xl font-semibold tabular-nums ${tone}`}>{value ?? '—'}</p>
  </Card>
);

const ACTION_LABEL: Record<string, string> = {
  'folder.created': 'Dossier créé',
  'folder.shared': 'Lien de signature créé',
  'folder.share_revoked': 'Lien de signature révoqué',
  'folder.delivered': 'Lien de signature ouvert',
  'folder.completed': 'Dossier terminé',
  'folder.failed': 'Dossier en échec',
  'document.imported': 'Document importé',
  'document.imported_via_link': 'Document reçu par lien',
  'document.signed': 'Document signé',
  'document.failed': 'Document en échec',
  'document.template_assigned': 'Template assigné',
  'template.created': 'Template créé',
  'template.updated': 'Template modifié',
  'session.photo_uploaded': 'Photo de signature reçue',
  'session.regions_submitted': 'Zones sélectionnées',
  'extraction.completed': 'Détourage réussi',
  'extraction.failed': 'Détourage en échec',
};

export const DashboardPage = () => {
  const { data: stats, isLoading } = useDashboard();
  const { data: folders } = useFolders();
  const { data: activity } = useActivity();

  const recent = (folders?.items ?? []).slice(0, 6);

  return (
    <Page title="Tableau de bord" description="Vue d’ensemble de votre activité de signature.">
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile label="Documents en attente" value={stats?.pendingDocuments} />
          <Tile label="Documents terminés" value={stats?.completedDocuments} tone="text-emerald-600" />
          <Tile
            label="Liens actifs"
            value={stats?.activeLinks}
            tone={stats?.activeLinks ? 'text-emerald-600' : 'text-ink-400'}
          />
          <Tile
            label="Erreurs"
            value={stats?.errors}
            tone={stats?.errors ? 'text-red-600' : 'text-ink-900'}
          />
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="border-b border-ink-200/70 px-5 py-3">
            <h2 className="text-sm font-semibold">Dossiers récents</h2>
          </div>
          {recent.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-400">Aucun dossier pour l’instant.</p>
          ) : (
            <ul className="divide-y divide-ink-200/70">
              {recent.map((folder) => (
                <li key={folder.id}>
                  <Link
                    to={`/folders/${folder.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-ink-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{folder.name}</p>
                      <p className="text-xs text-ink-400">
                        DOSSIER {folderReference(folder.reference)} ·{' '}
                        {folder.documents?.length ?? 0} document(s) · {formatDate(folder.createdAt)}
                      </p>
                    </div>
                    <FolderStatusPill status={folder.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <div className="border-b border-ink-200/70 px-5 py-3">
            <h2 className="text-sm font-semibold">Activité</h2>
          </div>
          {(activity?.items.length ?? 0) === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-400">Rien à afficher.</p>
          ) : (
            <ul className="divide-y divide-ink-200/70">
              {activity!.items.slice(0, 12).map((entry) => (
                <li key={entry.id} className="px-5 py-2.5">
                  <p className="text-sm">{ACTION_LABEL[entry.action] ?? entry.action}</p>
                  <p className="text-xs text-ink-400">{formatDate(entry.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
};
