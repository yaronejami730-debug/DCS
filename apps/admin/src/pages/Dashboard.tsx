import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FOLDER_STATUS_LABEL, type Folder, type FolderStatus } from '@scansign/shared';
import { useDashboard, useDashboardInsights, useFolders } from '../lib/queries';
import { Page } from '../components/Layout';
import { Card, FolderStatusPill, Spinner, folderReference, formatDate, timeAgo } from '../components/ui';
import { ClientSearch } from '../components/ClientSearch';
import { matchesSearch } from '../lib/search';

/**
 * The dashboard: what is waiting, what is done, what it costs.
 *
 * Four tiles answer the operator's first question — is anything stuck? — and a
 * fifth says how many remove.bg credits are left, because that is the one
 * external meter this product runs on. Below, a fortnight of signatures as
 * bars, the folders by state, and the folders themselves in two fold-out
 * lists: the ones still waiting, then all of them. The activity feed that
 * used to sit on the right is gone; nobody read it.
 */

const Tile = ({
  label,
  value,
  hint,
  tone = 'text-ink-900',
  to,
}: {
  label: string;
  value: number | string | undefined;
  hint?: string;
  tone?: string;
  to?: string;
}) => {
  const body = (
    <Card className="h-full p-5">
      <p className="text-sm text-ink-400">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tabular-nums ${tone}`}>{value ?? '—'}</p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </Card>
  );
  return to ? (
    <Link to={to} className="block h-full rounded-xl transition hover:-translate-y-0.5">
      {body}
    </Link>
  ) : (
    body
  );
};

const STATUS_ORDER: FolderStatus[] = ['pending', 'delivered', 'in_progress', 'processing', 'completed', 'error'];
const STATUS_BAR: Record<FolderStatus, string> = {
  pending: 'bg-amber-400',
  delivered: 'bg-sky-400',
  in_progress: 'bg-indigo-400',
  processing: 'bg-indigo-500',
  completed: 'bg-emerald-500',
  error: 'bg-red-500',
};

const DAY_LABEL = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }).replace('.', '');
};

/** A fold-out list of folders. `open` sets the initial state; the browser remembers the toggle. */
const FolderList = ({
  title,
  folders,
  empty,
  open,
}: {
  title: string;
  folders: Folder[];
  empty: string;
  open: boolean;
}) => (
  <Card>
    <details open={open} className="group">
      <summary className="flex cursor-pointer select-none items-center gap-3 border-b border-ink-200/70 px-5 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-ink-400 transition group-open:rotate-90">▶</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
          {folders.length}
        </span>
      </summary>
      {folders.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-ink-200/70">
          {folders.map((folder) => {
            const docs = (folder.documents ?? []).filter((d) => d.role !== 'for_signing');
            const signed = docs.filter((d) => d.status === 'completed').length;
            return (
              <li key={folder.id}>
                <Link
                  to={`/folders/${folder.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{folder.name}</p>
                    <p className="text-xs text-ink-400">
                      DOSSIER {folderReference(folder.reference)} · {signed}/{docs.length} signé
                      {docs.length > 1 ? 's' : ''} · créé {timeAgo(folder.createdAt)}
                      <span title={formatDate(folder.createdAt)} />
                    </p>
                  </div>
                  <FolderStatusPill status={folder.status} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  </Card>
);

export const DashboardPage = () => {
  const { data: stats, isLoading } = useDashboard();
  const { data: insights } = useDashboardInsights();
  const { data: folders } = useFolders();

  const [query, setQuery] = useState('');
  const all = (folders?.items ?? []).filter((f) => matchesSearch(f, query));
  const waiting = all.filter((f) => f.status !== 'completed');
  const maxPerDay = Math.max(1, ...(insights?.signedPerDay.map((d) => d.count) ?? [1]));
  const totalFolders = STATUS_ORDER.reduce((n, s) => n + (insights?.foldersByStatus[s] ?? 0), 0);

  const credits = insights?.removeBg;
  const creditsValue =
    insights === undefined ? undefined : credits ? credits.total + credits.freeCalls : 'indisponible';
  const creditsHint = credits
    ? `${credits.total} crédit${credits.total > 1 ? 's' : ''} · ${credits.freeCalls} appel${credits.freeCalls > 1 ? 's' : ''} gratuit${credits.freeCalls > 1 ? 's' : ''}`
    : insights
      ? 'Clé absente ou remove.bg injoignable'
      : undefined;

  return (
    <Page title="Tableau de bord" description="Ce qui attend, ce qui est signé, ce qu’il reste sur le compteur.">
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Tile label="Documents en attente" value={stats?.pendingDocuments} to="/folders" />
          <Tile
            label="Documents signés"
            value={stats?.completedDocuments}
            tone="text-emerald-600"
            hint={insights ? `${insights.signedLast7} cette semaine` : undefined}
          />
          <Tile
            label="Liens actifs"
            value={stats?.activeLinks}
            tone={stats?.activeLinks ? 'text-emerald-600' : 'text-ink-400'}
            hint={insights ? `${insights.pendingReturns} retour${insights.pendingReturns > 1 ? 's' : ''} à traiter` : undefined}
          />
          <Tile
            label="Erreurs"
            value={stats?.errors}
            tone={stats?.errors ? 'text-red-600' : 'text-ink-900'}
          />
          <Tile
            label="Crédits remove.bg"
            value={creditsValue}
            tone={
              credits === null
                ? 'text-ink-400 text-xl'
                : credits && credits.total + credits.freeCalls <= 5
                  ? 'text-red-600'
                  : 'text-ink-900'
            }
            hint={creditsHint}
          />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Signatures des 14 derniers jours</h2>
            {insights && (
              <p className="text-xs text-ink-400">
                {insights.signedLast7} sur 7 jours · {insights.signedLast30} sur 30 jours
              </p>
            )}
          </div>
          {!insights ? (
            <p className="py-10 text-center text-sm text-ink-400">Chargement…</p>
          ) : (
            <div className="mt-4 flex h-32 items-end gap-1.5">
              {insights.signedPerDay.map((d) => (
                <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.count} le ${d.day}`}>
                  <span className="text-[10px] tabular-nums text-ink-500">{d.count || ''}</span>
                  <div
                    className={`w-full rounded-t ${d.count ? 'bg-brand-500' : 'bg-ink-100'}`}
                    style={{ height: `${Math.max(4, (d.count / maxPerDay) * 88)}px` }}
                  />
                  <span className="truncate text-[10px] text-ink-400">{DAY_LABEL(d.day)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold">Dossiers par état</h2>
          {!insights ? (
            <p className="py-10 text-center text-sm text-ink-400">Chargement…</p>
          ) : (
            <>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-ink-100">
                {STATUS_ORDER.map((s) => {
                  const n = insights.foldersByStatus[s] ?? 0;
                  return n > 0 ? (
                    <div
                      key={s}
                      className={STATUS_BAR[s]}
                      style={{ width: `${(n / Math.max(totalFolders, 1)) * 100}%` }}
                      title={`${FOLDER_STATUS_LABEL[s]} : ${n}`}
                    />
                  ) : null;
                })}
              </div>
              <ul className="mt-3 space-y-1.5">
                {STATUS_ORDER.map((s) => (
                  <li key={s} className="flex items-center gap-2 text-sm">
                    <span className={`h-2.5 w-2.5 rounded-full ${STATUS_BAR[s]}`} />
                    <span className="flex-1 text-ink-600">{FOLDER_STATUS_LABEL[s]}</span>
                    <span className="tabular-nums font-medium">{insights.foldersByStatus[s] ?? 0}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-400">
                {totalFolders} dossier{totalFolders > 1 ? 's' : ''} · {insights.templates} template
                {insights.templates > 1 ? 's' : ''} réutilisable{insights.templates > 1 ? 's' : ''}
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="mt-6 space-y-4">
        <ClientSearch onFilter={setQuery} className="max-w-2xl" />
        <FolderList
          title="Dossiers en attente"
          folders={waiting}
          empty={query ? `Rien en attente pour « ${query} ».` : 'Rien en attente : tout est signé.'}
          open
        />
        <FolderList
          title="Tous les dossiers"
          folders={all}
          empty={query ? `Aucun dossier pour « ${query} ».` : 'Aucun dossier pour l’instant.'}
          open={Boolean(query)}
        />
      </div>
    </Page>
  );
};
