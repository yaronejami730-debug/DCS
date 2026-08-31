import { useState } from 'react';
import { useDeleteDevice, useDevices, useRenameDevice } from '../lib/queries';
import { Page } from '../components/Layout';
import { Button, Card, EmptyState, Field, Modal, Spinner, formatDate } from '../components/ui';

export const DevicesPage = () => {
  const { data, isLoading } = useDevices();
  const rename = useRenameDevice();
  const remove = useDeleteDevice();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  return (
    <Page
      title="Appareils"
      description="Les iPhones connectés à ce compte. Un appareil apparaît dès qu’il se connecte avec vos identifiants dans l’application."
    >
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
