import { useState } from 'react';
import { LINK_ACTIVITY_LABEL, type Document, type ShareLink } from '@scansign/shared';
import {
  useCreateShareLink,
  useRevokeShareLink,
  useSetShareLinkDocuments,
  useShareLinks,
} from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { DocumentPicker } from './DocumentPicker';
import { Button, Field, Modal, Select, Spinner, formatDate } from './ui';

/**
 * Share a folder with whoever has to sign it.
 *
 * The link is the whole delivery mechanism: there is no app to install and no
 * account to create, so the operator's job is to copy a URL and send it however
 * they already talk to that person — SMS, email, a chat message.
 *
 * What the holder of that link can do is deliberately narrow. They photograph
 * their signature and it lands on the documents this link names. They never see
 * those documents, their filenames, or how many there are; the API refuses
 * those routes to a share token rather than relying on this UI not to ask.
 * Saying so on screen matters — an operator who does not know that will
 * hesitate to send the link to an outside technician, which is exactly who it
 * is for.
 *
 * One link per signer, labelled and scoped, is the intended shape: the site
 * technician signs the delivery notes, the manager signs the contract, same
 * folder, different links. Minting a second does not kill the first, and
 * silently revoking somebody mid-signature would be worse than two live links.
 */

const EXPIRY_CHOICES = [
  { value: '7', label: '7 jours' },
  { value: '30', label: '30 jours' },
  { value: '90', label: '90 jours' },
  { value: 'never', label: 'Sans expiration' },
];

/**
 * Copy, with a fallback.
 *
 * `navigator.clipboard` needs a secure context, so it is absent over plain HTTP
 * on a LAN — which is how this console is reached in development. Falling back
 * to the old selection trick means the button is never dead, and the caller
 * finds out whether it worked.
 */
const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
};

/** Live within this window, or the dot goes grey. Two heartbeats of slack. */
const PRESENCE_WINDOW_MS = 40_000;

const LinkRow = ({
  link,
  folderId,
  documents,
}: {
  link: ShareLink;
  folderId: string;
  documents: Document[];
}) => {
  const revoke = useRevokeShareLink();
  const setDocuments = useSetShareLinkDocuments();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(link.documentIds);

  const copy = async () => {
    const ok = await copyText(link.url);
    setCopied(ok);
    // Long enough to read, short enough that the button is ready again before
    // the operator wants to send it to the next person.
    if (ok) setTimeout(() => setCopied(false), 2200);
  };

  return (
    <li className="rounded-lg px-3 py-3 ring-1 ring-ink-200/70">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{link.label ?? 'Lien de signature'}</span>
        {link.active ? (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
            Actif
          </span>
        ) : (
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-400">
            {link.revokedAt ? 'Révoqué' : 'Expiré'}
          </span>
        )}
        {link.requireLocation && (
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
            📍 position
          </span>
        )}
        {(() => {
          /*
            The presence dot. Green while the holder's page has heartbeat
            within the window — with what they are doing — grey with a "last
            seen" once it stops. Nothing shown before the first open: "jamais
            ouvert" already says that.
          */
          if (!link.lastActivityAt) return null;
          const live = Date.now() - new Date(link.lastActivityAt).getTime() < PRESENCE_WINDOW_MS;
          const label = link.lastActivityStep
            ? LINK_ACTIVITY_LABEL[link.lastActivityStep]
            : 'en ligne';
          return live ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {label}
            </span>
          ) : (
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-400">
              vu {formatDate(link.lastActivityAt)}
            </span>
          );
        })()}
        <span className="ml-auto text-xs text-ink-400">
          {link.openedCount > 0
            ? `Ouvert ${link.openedCount}× · dernier ${formatDate(link.lastOpenedAt)}`
            : 'Jamais ouvert'}
        </span>
      </div>

      {/*
        What this link actually signs. Stated on the row rather than hidden
        behind the edit dialog: with two technicians on one folder, "which of
        them gets the contract" is the thing the operator scans this list for.
      */}
      <p className="mt-1.5 text-xs text-ink-600">
        {link.documentIds.length === 0 ? (
          <>
            Envoie <span className="font-medium">toutes les feuilles de signature</span>
          </>
        ) : (
          <>
            Envoie{' '}
            <span className="font-medium">
              {link.documentIds.length} feuille{link.documentIds.length > 1 ? 's' : ''}
            </span>{' '}
            <span className="text-ink-400">
              ·{' '}
              {documents
                .filter((d) => link.documentIds.includes(d.id))
                .map((d) => d.filename)
                .join(', ')}
            </span>
          </>
        )}
      </p>

      {link.active && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/*
            Readonly rather than plain text: the operator can select it by hand
            if the copy button is blocked, and it wraps instead of stretching
            the panel to the width of a 43-character token.
          */}
          <input
            readOnly
            value={link.url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-lg bg-ink-50 px-2.5 py-1.5 font-mono text-xs text-ink-600 ring-1 ring-ink-200 outline-none"
          />
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? 'Copié ✓' : 'Copier'}
          </Button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 text-xs text-ink-400">
        <span>Créé le {formatDate(link.createdAt)}</span>
        <span>·</span>
        <span>
          {link.expiresAt ? `Expire le ${formatDate(link.expiresAt)}` : 'Sans expiration'}
        </span>
        {link.active && (
          <>
            <button
              onClick={() => {
                setDraft(link.documentIds);
                setEditing(true);
              }}
              className="ml-auto font-medium text-brand-600 hover:underline"
            >
              Documents
            </button>
            <button
              onClick={() => setConfirming(true)}
              className="font-medium text-red-600 hover:underline"
            >
              Révoquer
            </button>
          </>
        )}
      </div>

      {/*
        Editing the subset keeps the URL. Adding a document to a technician's
        link is an ordinary correction, and reissuing for it would mean chasing
        the person who already has the old link.
      */}
      <Modal
        open={editing}
        title={`Documents de « ${link.label ?? 'ce lien'} »`}
        onClose={() => setEditing(false)}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Quelles feuilles ce technicien reçoit. Avec plusieurs signataires sur le même
            dossier, chacun n’imprime que la sienne.
          </p>

          <DocumentPicker documents={documents} selected={draft} onChange={setDraft} />

          <p className="text-xs text-ink-400">
            Une signature déjà reçue et apposée n’est pas retirée si vous réduisez la sélection :
            elle est dans les PDF. Cela ne change que ce que le lien donne à partir de maintenant.
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Annuler
            </Button>
            <Button
              loading={setDocuments.isPending}
              onClick={() =>
                setDocuments.mutate(
                  { folderId, linkId: link.id, documentIds: draft },
                  { onSuccess: () => setEditing(false) },
                )
              }
            >
              Enregistrer
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={confirming}
        title="Révoquer ce lien ?"
        onClose={() => setConfirming(false)}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Le lien cessera immédiatement de fonctionner. Une signature déjà envoyée reste
            acquise ; une signature en cours sera interrompue. C’est définitif — pour redonner
            l’accès, il faudra créer un nouveau lien.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() =>
                revoke.mutate(
                  { folderId, linkId: link.id },
                  { onSuccess: () => setConfirming(false) },
                )
              }
            >
              Révoquer
            </Button>
          </div>
        </div>
      </Modal>
    </li>
  );
};

export const ShareLinkPanel = ({
  folderId,
  documents,
}: {
  folderId: string;
  /**
   * The folder's capture sheets — the pages a technician prints and signs.
   *
   * Not the contracts: those never travel to the signer, and offering them here
   * would let an operator send a client's paperwork out by SMS with one
   * mis-click.
   */
  documents: Document[];
}) => {
  const { data, isLoading, error: listError } = useShareLinks(folderId);
  const create = useCreateShareLink();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [picked, setPicked] = useState<string[]>([]);
  // On by default: a field signature's evidence is where and when it happened.
  const [requireLocation, setRequireLocation] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Only the links meant to be sent to someone.
   *
   * The phone-handoff button mints 'operator' links against the same folder,
   * and listing those here would mix two different things: one is a credential
   * you hand out, the other is a 24-hour hop from your desk to your own pocket.
   */
  const links = (data?.items ?? []).filter((l) => l.scope === 'signer');
  const active = links.filter((l) => l.active);

  const submit = () => {
    setError(null);
    create.mutate(
      {
        folderId,
        scope: 'signer',
        label: label.trim() || null,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
        documentIds: picked,
        requireLocation,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setLabel('');
          setPicked([]);
          setRequireLocation(true);
        },
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Création du lien impossible.'),
      },
    );
  };

  return (
    <>
      <div className="mb-4 rounded-xl bg-white ring-1 ring-ink-200/70">
        <div className="flex flex-wrap items-center gap-3 border-b border-ink-200/70 px-5 py-3">
          <h2 className="text-sm font-semibold">Liens de signature</h2>
          <span className="text-xs text-ink-400">
            {active.length === 0
              ? 'Aucun lien actif'
              : `${active.length} lien${active.length > 1 ? 's' : ''} actif${active.length > 1 ? 's' : ''}`}
          </span>
          <Button
            className="ml-auto"
            disabled={documents.length === 0}
            onClick={() => {
              setPicked([]);
              setOpen(true);
            }}
          >
            🔗 Créer un lien
          </Button>
        </div>

        {isLoading ? (
          <div className="px-5 py-6">
            <Spinner />
          </div>
        ) : listError ? (
          <p className="px-5 py-6 text-sm text-red-700">
            {listError instanceof ApiRequestError ? listError.message : 'Liens indisponibles.'}
          </p>
        ) : documents.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-600">
            Aucune feuille de signature dans ce dossier. Importez un PDF avec « Importer des PDF »
            en haut de la page, puis choisissez « un lien de signature ».
          </p>
        ) : (
          <>
            {/*
              The sheets themselves, before the links. They are excluded from
              the "Documents à faire signer" card by design, so this is the ONE
              place they are visible — without this list, an imported sheet
              landed in the folder and appeared nowhere, which read as a failed
              import.
            */}
            <div className="border-b border-ink-200/70 px-5 py-3">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-400">
                Feuilles de signature
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {documents.map((doc) => (
                  <li key={doc.id} className="flex items-center gap-2.5 text-sm">
                    <span className="shrink-0">📄</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{doc.filename}</span>
                    <span className="shrink-0 text-xs text-ink-400">
                      {doc.pageCount} page{doc.pageCount > 1 ? 's' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {links.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-400">
                Créez un lien et envoyez-le au signataire. Il imprime la feuille, la signe à la
                main, la photographie et vous la renvoie — depuis n’importe quel navigateur, sans
                compte.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 px-4 py-4">
                {links.map((link) => (
                  <LinkRow key={link.id} link={link} folderId={folderId} documents={documents} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <Modal open={open} title="Créer un lien de signature" onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Le porteur du lien pourra imprimer ces feuilles, les signer à la main et vous les
            renvoyer photographiées. Il ne verra aucun des documents à faire signer du dossier.
          </p>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-800">
              Feuilles envoyées au signataire
            </span>
            <DocumentPicker documents={documents} selected={picked} onChange={setPicked} />
          </div>

          <Field
            label="Pour qui ? (facultatif)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Technicien Renault"
            hint="Sert uniquement à vous y retrouver quand plusieurs personnes signent le même dossier."
          />

          <Select
            label="Expiration"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          >
            {EXPIRY_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>

          {expiry === 'never' && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
              Un lien sans expiration reste utilisable tant qu’il n’est pas révoqué, y compris
              s’il est transféré à quelqu’un d’autre.
            </p>
          )}

          {/*
            Consent, not surveillance: the technician's browser will prompt them
            and they can refuse. Said plainly here so the operator knows what
            they are switching on — a location they may or may not receive.
          */}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg p-3 ring-1 ring-ink-200">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-ink-300 accent-brand-600"
              checked={requireLocation}
              onChange={(e) => setRequireLocation(e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-ink-800">
                Demander la position à la signature
              </span>
              <span className="mt-0.5 block text-xs text-ink-400">
                Le technicien devra autoriser la géolocalisation en renvoyant les pages. Il peut
                refuser — la position est alors simplement absente.
              </span>
            </span>
          </label>

          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button
              loading={create.isPending}
              disabled={documents.length === 0}
              onClick={submit}
            >
              Créer le lien
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};
