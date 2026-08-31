import { useState } from 'react';
import { useDeleteDevice, useDevices, useNotifications, useRenameDevice } from '../lib/queries';
import { Page } from '../components/Layout';
import { Button, Card, EmptyState, Field, Modal, Spinner, formatDate } from '../components/ui';

export const DevicesPage = () => {
  const { data, isLoading } = useDevices();
  const { data: notifications } = useNotifications();
  const rename = useRenameDevice();

  // A device without a push token cannot be reached when the app is closed.
  // Saying so here beats a silent "skipped" in a log nobody reads.
  const withoutPush = (data?.items ?? []).filter((d) => !d.pushToken).length;
  const remove = useDeleteDevice();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  return (
    <Page
      title="Appareils"
      description="Les iPhones connectés à ce compte. Un appareil apparaît dès qu’il se connecte avec vos identifiants dans l’application."
    >
      {withoutPush > 0 && (
        <Card className="mb-4 border-l-4 border-l-amber-500 p-4">
          <p className="text-sm font-medium text-amber-800">
            {withoutPush} appareil(s) sans notifications à distance
          </p>
          <p className="mt-1 text-sm text-ink-600">
            Ces appareils reçoivent bien les documents en direct et affichent une alerte tant que
            l’application est ouverte. Pour être prévenus application fermée, il faut un build de
            développement : <code className="rounded bg-ink-100 px-1">eas init</code> puis{' '}
            <code className="rounded bg-ink-100 px-1">
              eas build --profile development --platform ios
            </code>
            .
          </p>
        </Card>
      )}

      {isLoading ? (
        <Spinner />
      ) : (data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Aucun appareil"
            description="Ouvrez l’application Scan&Sign sur l’iPhone, connectez-vous avec ce même compte et nommez l’appareil. Il apparaîtra ici."
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-200/70">
            {data!.items.map((device) => (
              <li key={device.id} className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      device.online ? 'bg-emerald-500' : 'bg-ink-200'
                    }`}
                    title={device.online ? 'En ligne' : 'Hors ligne'}
                  />
                  <div>
                    <p className="text-sm font-medium">{device.name}</p>
                    <p className="text-xs text-ink-400">
                      {device.online ? 'En ligne' : 'Hors ligne'} · dernière activité{' '}
                      {formatDate(device.lastSeenAt)}
                      {device.pushToken ? ' · notifications actives' : ' · notifications inactives'}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setEditing({ id: device.id, name: device.name })}
                  >
                    Renommer
                  </Button>
                  <Button
                    variant="danger"
                    loading={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Supprimer « ${device.name} » ?`)) remove.mutate(device.id);
                    }}
                  >
                    Supprimer
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <div className="border-b border-ink-200/70 px-5 py-3">
          <h2 className="text-sm font-semibold">Notifications envoyées</h2>
        </div>
        {(notifications?.items.length ?? 0) === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-400">Aucune notification.</p>
        ) : (
          <ul className="divide-y divide-ink-200/70">
            {notifications!.items.slice(0, 15).map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-5 py-3">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    entry.status === 'sent'
                      ? 'bg-emerald-500'
                      : entry.status === 'failed'
                        ? 'bg-red-500'
                        : 'bg-ink-200'
                  }`}
                  title={entry.status}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.title}</p>
                  <p className="text-xs text-ink-600">{entry.body}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {formatDate(entry.created_at)}
                    {entry.error ? ` · ${entry.error}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={editing !== null} title="Renommer l’appareil" onClose={() => setEditing(null)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!editing) return;
            rename.mutate({ id: editing.id, name: editing.name }, { onSuccess: () => setEditing(null) });
          }}
          className="space-y-4"
        >
          <Field
            label="Nom"
            value={editing?.name ?? ''}
            onChange={(e) => setEditing((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            required
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button type="submit" loading={rename.isPending}>
              Enregistrer
            </Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
};
