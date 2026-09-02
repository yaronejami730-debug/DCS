import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiRequestError } from '../lib/api';
import {
  useCreateFolder,
  useQhareWebhook,
  type ClientSuggestion,
  type ClientSearchResult,
} from '../lib/queries';
import { Button } from './ui';

/**
 * The search box that knows the clients.
 *
 * Type two letters and the list underneath fills with the CRM's clients
 * (Qhare, once connected) and the folders already here. Next to each client:
 * « Créer un dossier », which opens a folder in their name; next to each
 * existing folder: « Ouvrir ». With no match, the text itself can become a
 * folder. The list is debounced so the CRM is not asked on every keystroke,
 * and it closes on Escape or on a click outside.
 *
 * `onFilter` also feeds the typed text to the page, so the lists below narrow
 * at the same time — the same box does both jobs.
 */
export const ClientSearch = ({
  onFilter,
  className = '',
  autoFocus = false,
}: {
  onFilter?: (query: string) => void;
  className?: string;
  autoFocus?: boolean;
}) => {
  const navigate = useNavigate();
  const create = useCreateFolder();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ClientSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  /** The Qhare set-up card, and the account's webhook URL once it is asked for. */
  const [showSetup, setShowSetup] = useState(false);
  const webhook = useQhareWebhook(showSetup);
  const box = useRef<HTMLDivElement>(null);

  // Debounced search: the CRM answers in hundreds of milliseconds, the operator
  // types faster than that.
  useEffect(() => {
    onFilter?.(query);
    const q = query.trim();
    if (q.length < 2) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api<ClientSearchResult>(`/clients/search?q=${encodeURIComponent(q)}`);
        if (!cancelled) setResult(r);
      } catch {
        if (!cancelled) setResult({ items: [], crm: { name: 'qhare', configured: false, leads: 0, error: 'recherche indisponible' } });
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const createFolder = (name: string, key: string, crmLeadId?: string | null) => {
    setError(null);
    setCreatingFor(key);
    create.mutate(
      { name, crmLeadId: crmLeadId ?? null },
      {
        onSuccess: (folder) => {
          setOpen(false);
          setQuery('');
          navigate(`/folders/${folder.id}`);
        },
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Création du dossier impossible.'),
        onSettled: () => setCreatingFor(null),
      },
    );
  };

  const items = result?.items ?? [];
  const qhare = items.filter((i) => i.source === 'qhare');
  const folders = items.filter((i) => i.source === 'folder');
  const typed = query.trim();
  const exactFolder = folders.some((f) => f.name.toLowerCase() === typed.toLowerCase());
  const showList = open && typed.length >= 2;

  return (
    <div ref={box} className={`relative ${className}`}>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400">⌕</span>
        <input
          type="search"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter' && typed.length >= 2 && !exactFolder) createFolder(typed, 'typed');
          }}
          placeholder="Rechercher un client (Qhare), un dossier… ou taper un nom pour créer un dossier"
          className="w-full rounded-lg bg-white py-2.5 pl-9 pr-9 text-sm ring-1 ring-ink-200 outline-none placeholder:text-ink-400 focus:ring-2 focus:ring-brand-500"
          role="combobox"
          aria-expanded={showList}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setOpen(false);
            }}
            aria-label="Effacer la recherche"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-ink-400 hover:text-ink-700"
          >
            ×
          </button>
        )}
      </div>

      {showList && (
        <div className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-ink-200">
          {/* Clients from the CRM */}
          <div className="border-b border-ink-100 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-400">
            Clients Qhare
            {searching && <span className="ml-2 font-normal normal-case tracking-normal">recherche…</span>}
          </div>
          {result && !result.crm.configured ? (
            <div className="px-3 py-2.5 text-xs text-amber-800">
              Aucun client Qhare reçu pour l’instant.{' '}
              <button type="button" className="underline" onClick={() => setShowSetup((v) => !v)}>
                Connecter Qhare
              </button>
              {showSetup && (
                <div className="mt-2 rounded-lg bg-white p-2.5 text-ink-700 ring-1 ring-amber-200">
                  <p className="font-semibold">Dans Qhare → Webhook :</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    <li>Nom du webhook : <b>Scan&amp;Sign</b></li>
                    <li>Événement : création <i>et</i> modification de lead (un webhook par événement si nécessaire)</li>
                    <li>Modèle : <b>Lead</b></li>
                    <li>
                      Url de destination :{' '}
                      {webhook.data ? (
                        <code className="select-all break-all rounded bg-ink-100 px-1">{webhook.data.url}</code>
                      ) : (
                        <span className="text-ink-400">génération…</span>
                      )}
                    </li>
                  </ul>
                  <p className="mt-1.5 text-ink-500">
                    Chaque lead créé ou modifié dans Qhare apparaîtra ici. Les leads existants
                    arrivent au fil de leurs modifications.
                  </p>
                </div>
              )}
            </div>
          ) : result?.crm.error ? (
            <p className="px-3 py-2.5 text-xs text-red-700">Qhare injoignable : {result.crm.error}</p>
          ) : qhare.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-ink-400">
              {searching ? 'Interrogation de Qhare…' : `Aucun client Qhare pour « ${typed} ».`}
            </p>
          ) : (
            <ul>
              {qhare.map((client) => (
                <Row
                  key={`q-${client.id}`}
                  client={client}
                  action="Créer un dossier"
                  busy={creatingFor === `q-${client.id}`}
                  onAction={() => createFolder(client.name, `q-${client.id}`, client.crmLeadId)}
                />
              ))}
            </ul>
          )}

          {/* Folders already here */}
          {folders.length > 0 && (
            <>
              <div className="border-y border-ink-100 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-400">
                Dossiers existants
              </div>
              <ul>
                {folders.map((f) => (
                  <Row
                    key={`f-${f.id}`}
                    client={f}
                    action="Ouvrir"
                    secondary
                    onAction={() => {
                      setOpen(false);
                      navigate(`/folders/${f.folderId}`);
                    }}
                  />
                ))}
              </ul>
            </>
          )}

          {/* The typed name itself */}
          {!exactFolder && (
            <div className="flex items-center justify-between gap-3 border-t border-ink-100 px-3 py-2.5">
              <span className="min-w-0 truncate text-sm text-ink-600">
                Nouveau dossier « <b className="text-ink-900">{typed}</b> »
              </span>
              <Button
                variant="secondary"
                className="shrink-0"
                loading={creatingFor === 'typed'}
                onClick={() => createFolder(typed, 'typed')}
              >
                Créer un dossier
              </Button>
            </div>
          )}
          {error && <p className="border-t border-ink-100 px-3 py-2 text-xs text-red-700">{error}</p>}
        </div>
      )}
    </div>
  );
};

const Row = ({
  client,
  action,
  busy = false,
  secondary = false,
  onAction,
}: {
  client: ClientSuggestion;
  action: string;
  busy?: boolean;
  secondary?: boolean;
  onAction: () => void;
}) => (
  <li className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-ink-50">
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-ink-900">{client.name}</p>
      {(client.email || client.phone || client.city || client.detail) && (
        <p className="truncate text-xs text-ink-400">
          {[client.city, client.phone, client.email, client.detail].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
    <Button
      variant={secondary ? 'secondary' : 'primary'}
      className="shrink-0"
      loading={busy}
      onClick={onAction}
    >
      {action}
    </Button>
  </li>
);
