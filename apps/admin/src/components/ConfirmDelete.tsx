import { Button, Modal } from './ui';

/**
 * The one question asked before something is deleted for good.
 *
 * Same words everywhere — a folder from the dashboard, ten folders at once, a
 * folder from its own page — so the operator learns one dialog. The red button
 * is the only primary action; Escape and « Annuler » both do nothing.
 */
export const ConfirmDelete = ({
  open,
  title,
  what,
  count = 1,
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  /** Named in the sentence: « ce dossier », « ces 3 dossiers ». */
  what: string;
  count?: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <Modal open={open} title={title} onClose={onCancel}>
    <div className="space-y-4">
      <p className="text-sm text-ink-800">
        Êtes-vous sûr de vouloir supprimer {what} ?
      </p>
      <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
        <b>Attention : cette action est irréversible.</b>{' '}
        {count > 1 ? 'Les dossiers, leurs documents' : 'Le dossier, ses documents'}, PDF signés,
        liens de signature et retours seront supprimés définitivement de la base de données.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button variant="danger" onClick={onConfirm} loading={busy}>
          Supprimer{count > 1 ? ` ${count} dossiers` : ''}
        </Button>
      </div>
    </div>
  </Modal>
);
