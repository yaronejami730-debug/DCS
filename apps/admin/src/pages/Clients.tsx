import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../lib/api';
import {
  useClients,
  useCreateFolder,
  useImportClients,
  useQhareWebhook,
  type ClientRow,
} from '../lib/queries';
import { Page } from '../components/Layout';
import { Button, Card, Spinner, timeAgo } from '../components/ui';

/**
 * The client base: every lead mirrored from Qhare, as a table.
 *
 * What the CSV holds, in one view — name, phone, e-mail, address, category,
 * state, Qhare file number — with the same search as the search bar and one
 * button per row: « Créer un dossier », or « Ouvrir » when a folder already
 * belongs to that client. Import and webhook controls sit at the top: this is
 * where the base is fed, the search bar only reads it.
 */
const PAGE = 50;

export const ClientsPage = () => {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading } = useClients(debounced, page * PAGE, PAGE);
  const create = useCreateFolder();
  const importClients = useImportClients();
  const [showWebhook, setShowWebhook] = useState(false);
  const webhook = useQhareWebhook(showWebhook);
  const csvInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  const createFolder = (client: ClientRow) => {
    setError(null);
    setCreating(client.id);
    create.mutate(
      { name: client.name, crmLeadId: client.externalId },
      {
        onSuccess: (folder) => navigate(`/folders/${folder.id}`),
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Création du dossier impossible.'),
        onSettled: () => setCreating(null),
      },
    );
  };

  const onCsv = (file: File | undefined) => {
    if (!file) return;
    setNotice(null);
    setError(null);
    importClients.mutate(file, {
      onSuccess: (r) =>
        setNotice(
          `${r.imported} client${r.imported > 1 ? 's' : ''} importé${r.imported > 1 ? 's' : ''} sur ${r.rows} ligne${r.rows > 1 ? 's' : ''}` +
            (r.skipped.length ? ` · ${r.skipped.length} ligne(s) ignorée(s)` : ''),
        ),
      onError: (e) => setError(e instanceof ApiRequestError ? e.message : 'Import impossible.'),
    });
  };

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <Page
      title="Clients"
      description="Votre base clients Qhare : importée une fois, tenue à jour par le webhook, cherchée depuis chaque barre de recherche."
      actions={
        <>
          <Button variant="secondary" onClick={() => setShowWebhook((v) => !v)}>
            Webhook Qhare
          </Button>
          <Button loading={importClients.isPending} onClick={() => csvInput.current?.click()}>
            Importer un export CSV
          </Button>
          <input
            ref={csvInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              onCsv(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </>
      }
    >
      {showWebhook && (
        <Card className="mb-4 p-4 text-sm">
          <p className="font-semibold">Dans Qhare → Webhook</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink-600">
            <li>Nom : <b>Scan&amp;Sign</b> · Modèle : <b>Lead</b> · Événements : création et modification</li>
            <li>
              Url de destination :{' '}
              {webhook.data ? (
                <code className="select-all break-all rounded bg-ink-100 px-1">{webhook.data.url}</code>
              ) : (
                <span className="text-ink-400">génération…</span>
              )}
            </li>
          </ul>
        </Card>
      )}
      {notice && <Card className="mb-4 border-l-4 border-l-emerald-500 p-4 text-sm text-emerald-800">{notice}</Card>}
      {error && <Card className="mb-4 border-l-4 border-l-red-500 p-4 text-sm text-red-700">{error}</Card>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative max-w-xl flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400">⌕</span>
          <input
            type="search"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nom, téléphone, e-mail, ville, code postal, n° de dossier…"
            className="w-full rounded-lg bg-white py-2.5 pl-9 pr-3 text-sm ring-1 ring-ink-200 outline-none placeholder:text-ink-400 focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <span className="text-sm text-ink-400">
          {isLoading ? '…' : `${total} client${total > 1 ? 's' : ''}${debounced ? ` pour « ${debounced} »` : ''}`}
        </span>
      </div>

      <Card>
        {isLoading ? (
          <div className="p-8">
            <Spinner />
          </div>
        ) : (data?.items.length ?? 0) === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-400">
            {debounced
              ? `Aucun client pour « ${debounced} ».`
              : 'Aucun client. Importez l’export CSV de vos leads Qhare, ou attendez le premier lead envoyé par le webhook.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Client</th>
                  <th className="px-4 py-2.5 font-semibold">Contact</th>
                  <th className="px-4 py-2.5 font-semibold">Adresse</th>
                  <th className="px-4 py-2.5 font-semibold">Catégorie · État</th>
                  <th className="px-4 py-2.5 font-semibold">Dossier Qhare</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Dossier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200/70">
                {data!.items.map((c) => (
                  <tr key={c.id} className="hover:bg-ink-50">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-ink-900">{c.name}</p>
                      {c.company && <p className="text-xs text-ink-400">{c.company}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-ink-700">
                      {c.phone && <p>{c.phone}</p>}
                      {c.email && <p className="text-xs text-ink-500">{c.email}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-ink-700">
                      {c.address && <p className="text-xs">{c.address}</p>}
                      <p>{[c.postalCode, c.city].filter(Boolean).join(' ')}</p>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-600">
                      {[c.category, c.state].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-600">
                      <p>{c.reference ?? '—'}</p>
                      <p className="text-ink-400">id {c.externalId} · maj {timeAgo(c.updatedAt)}</p>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {c.folderId ? (
                        <Link to={`/folders/${c.folderId}`}>
                          <Button variant="secondary">Ouvrir le dossier</Button>
                        </Link>
                      ) : (
                        <Button loading={creating === c.id} onClick={() => createFolder(c)}>
                          Créer un dossier
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-ink-200/70 px-4 py-3 text-sm">
            <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ‹ Précédents
            </Button>
            <span className="text-ink-400">
              Page {page + 1} / {pages}
            </span>
            <Button variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              Suivants ›
            </Button>
          </div>
        )}
      </Card>
    </Page>
  );
};
