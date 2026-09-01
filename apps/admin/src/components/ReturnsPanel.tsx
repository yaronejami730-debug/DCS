import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ShareLinkReturn } from '@scansign/shared';
import { useDeleteReturn, useMarkReturnHandled, useReturns } from '../lib/queries';
import { PdfViewer } from './PdfViewer';
import { Button, Card, Modal, Spinner, formatDate } from './ui';

/**
 * Signed pages the technicians have sent back.
 *
 * This is the operator's inbox for the return leg: the technician printed the
 * documents, signed them by hand and photographed the result, and what lands
 * here is that raw scan. Nothing has been decided about it yet — the operator
 * opens one, crops each mark out of it and says what each mark is.
 *
 * Unhandled ones are listed first and marked, because this panel answers "what
 * is waiting for me" and a list where done and pending look alike answers
 * nothing.
 */
const humanSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.round(bytes / 1024)} ko`;

export const ReturnsPanel = ({ folderId }: { folderId: string }) => {
  const { data, isLoading } = useReturns(folderId);
  const handled = useMarkReturnHandled();
  const remove = useDeleteReturn();
  const [deleting, setDeleting] = useState<string | null>(null);
  /** The return open in the viewer — the scan the operator is about to judge. */
  const [viewing, setViewing] = useState<ShareLinkReturn | null>(null);

  const items = data?.items ?? [];
  // Waiting first: this panel is a to-do list, not an archive.
  const pending = items.filter((r) => !r.handledAt);
  const done = items.filter((r) => r.handledAt);

  // Nothing has come back yet. Saying so would add a permanently empty box to
  // every folder, so the panel simply is not there until it has something.
  if (!isLoading && items.length === 0) return null;

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-200/70 px-5 py-3">
        <h2 className="text-sm font-semibold">Documents signés reçus</h2>
        {pending.length > 0 && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
            {pending.length} à traiter
          </span>
        )}
      </div>

      {isLoading ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-ink-200/70">
          {[...pending, ...done].map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <span className="shrink-0 text-lg">
                {item.contentType === 'application/pdf' ? '📄' : '🖼️'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.filename}</p>
                <p className="mt-0.5 text-xs text-ink-400">
                  Reçu le {formatDate(item.createdAt)} · {humanSize(item.byteSize)}
                  {item.pageCount ? ` · ${item.pageCount} page(s)` : ''}
                </p>
                {item.location && (
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${item.location.latitude}&mlon=${item.location.longitude}#map=17/${item.location.latitude}/${item.location.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                  >
                    📍 {item.location.latitude.toFixed(5)}, {item.location.longitude.toFixed(5)}
                    {item.location.accuracy ? ` · ±${Math.round(item.location.accuracy)} m` : ''}
                  </a>
                )}
              </div>

              {item.handledAt ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                  Traité
                </span>
              ) : (
                <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                  À traiter
                </span>
              )}

              {item.url && (
                <Button variant="secondary" onClick={() => setViewing(item)}>
                  Voir
                </Button>
              )}

              <Link to={`/folders/${folderId}/reception/${item.id}`}>
                <Button variant={item.handledAt ? 'secondary' : 'primary'}>
                  Capturer les signatures
                </Button>
              </Link>

              {!item.handledAt && (
                <Button
                  variant="ghost"
                  loading={handled.isPending}
                  onClick={() => handled.mutate({ folderId, returnId: item.id })}
                >
                  Ignorer
                </Button>
              )}

              <Button variant="danger" onClick={() => setDeleting(item.id)}>
                Supprimer
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/*
        The scan, in place. It used to open in a raw browser tab — a PDF viewer
        at best, a download at worst — when the whole point of looking is to
        decide, right here, whether it is worth cropping.
      */}
      <Modal
        open={viewing !== null}
        size="wide"
        title={viewing?.filename ?? 'Document reçu'}
        onClose={() => setViewing(null)}
        actions={
          viewing && (
            <Link to={`/folders/${folderId}/reception/${viewing.id}`}>
              <Button>Capturer les signatures</Button>
            </Link>
          )
        }
      >
        {viewing?.url &&
          (viewing.contentType === 'application/pdf' ? (
            <PdfViewer url={viewing.url} maxWidth={860} />
          ) : (
            <img
              src={viewing.url}
              alt={viewing.filename}
              className="mx-auto max-h-[75vh] rounded-lg ring-1 ring-ink-200"
            />
          ))}
        {viewing?.location && (
          <p className="mt-3 text-center text-xs text-ink-500">
            📍 Signé le {formatDate(viewing.location.at)} à {viewing.location.latitude.toFixed(5)},{' '}
            {viewing.location.longitude.toFixed(5)}
            {viewing.location.accuracy ? ` (±${Math.round(viewing.location.accuracy)} m)` : ''}
          </p>
        )}
      </Modal>

      <Modal
        open={deleting !== null}
        title="Supprimer ce document reçu ?"
        onClose={() => setDeleting(null)}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Le scan sera effacé du stockage, définitivement. Les signatures déjà apposées sur vos
            documents ne sont pas retirées — elles sont dans les PDF.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Annuler
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                deleting &&
                remove.mutate(
                  { folderId, returnId: deleting },
                  { onSuccess: () => setDeleting(null) },
                )
              }
            >
              Supprimer
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
};
