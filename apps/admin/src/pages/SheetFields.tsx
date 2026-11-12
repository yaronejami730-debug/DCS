import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ZONE_TYPE, ZONE_TYPE_LABEL, sheetFieldTargetsDocument, type ZoneType } from '@scansign/shared';
import {
  useCreateSheetField,
  useDeleteSheetField,
  useReorderSheetFields,
  useSaveTemplate,
  useSheetFields,
  useTemplates,
  useUpdateSheetField,
  type SheetFieldRow,
} from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { Page } from '../components/Layout';
import { Button, Card, EmptyState, Field, Modal, Select, Spinner } from '../components/ui';

type SizeClass = 'square' | 'narrow' | 'wide';

const SIZE_LABEL: Record<SizeClass, string> = {
  square: 'Carré (signature, tampon)',
  narrow: 'Étroit (une ligne : nom, date)',
  wide: 'Large (plusieurs lignes : mention)',
};

interface DraftState {
  label: string;
  shortLabel: string;
  hint: string;
  type: ZoneType;
  sizeClass: SizeClass;
  targets: string;
}

const EMPTY_DRAFT: DraftState = {
  label: '',
  shortLabel: '',
  hint: '',
  type: 'signature',
  sizeClass: 'square',
  targets: '',
};

const rowToDraft = (row: SheetFieldRow): DraftState => ({
  label: row.label,
  shortLabel: row.shortLabel,
  hint: row.hint,
  type: row.type,
  sizeClass: row.sizeClass,
  targets: row.targets.join(', '),
});

/**
 * Repères — the capture-sheet's fields, editable here instead of hardcoded.
 *
 * Position is never set by hand: the API recomputes and persists it (a flow
 * layout, see `layoutSheetFields` in @scansign/shared) on every create, edit,
 * delete and reorder, so the printed sheet and the detector never drift apart.
 *
 * The association section reuses the same routing logic the API applies at
 * placement time (`sheetFieldsForDocument`): a signature box is picked by an
 * explicit choice on a template's zone, else on the template itself, else by
 * keyword — shown here so an operator sees, and can fix, every template's
 * routing from one place instead of opening each one.
 */
export const SheetFieldsPage = () => {
  const { data, isLoading } = useSheetFields();
  const create = useCreateSheetField();
  const update = useUpdateSheetField();
  const remove = useDeleteSheetField();
  const reorder = useReorderSheetFields();

  const [editing, setEditing] = useState<string | null>(null); // key, or 'new'
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const items = data?.items ?? [];

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setError(null);
    setEditing('new');
  };
  const openEdit = (row: SheetFieldRow) => {
    setDraft(rowToDraft(row));
    setError(null);
    setEditing(row.key);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const input = {
      label: draft.label.trim(),
      shortLabel: draft.shortLabel.trim(),
      hint: draft.hint.trim(),
      type: draft.type,
      sizeClass: draft.sizeClass,
      targets: draft.targets
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    };
    const onError = (e: unknown) =>
      setError(e instanceof ApiRequestError ? e.message : 'Enregistrement impossible.');
    if (editing === 'new') {
      create.mutate(input, { onSuccess: () => setEditing(null), onError });
    } else if (editing) {
      update.mutate({ key: editing, input }, { onSuccess: () => setEditing(null), onError });
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const keys = items.map((r) => r.key);
    [keys[index], keys[target]] = [keys[target]!, keys[index]!];
    reorder.mutate(keys);
  };

  const del = (row: SheetFieldRow) => {
    if (!window.confirm(`Supprimer le repère « ${row.label} » ?`)) return;
    setError(null);
    setBusyKey(row.key);
    remove.mutate(row.key, {
      onError: (e) => setError(e instanceof ApiRequestError ? e.message : 'Suppression impossible.'),
      onSettled: () => setBusyKey(null),
    });
  };

  // --- association: which template routes to which signature box ----------
  const { data: templatesData } = useTemplates();
  const saveTemplate = useSaveTemplate();
  const signatureFields = items.filter((f) => f.type === 'signature');
  const signatureTemplates = (templatesData?.items ?? []).filter((t) =>
    t.zones?.some((z) => z.type === 'signature'),
  );
  const zoneLockedKey = (t: (typeof signatureTemplates)[number]) =>
    t.zones?.find((z) => z.type === 'signature' && z.sheetField)?.sheetField ?? null;
  const boxFor = (t: (typeof signatureTemplates)[number]) =>
    zoneLockedKey(t) ??
    t.sheetField ??
    signatureFields.find((f) => sheetFieldTargetsDocument(f, [t.name]))?.key ??
    null;
  const reassign = (t: (typeof signatureTemplates)[number], key: string) =>
    saveTemplate.mutate({
      id: t.id,
      input: {
        reusable: t.reusable,
        name: t.name,
        documentHash: t.documentHash,
        filenamePattern: t.filenamePattern,
        sheetField: key || null,
        pageCount: t.pageCount,
        zones: (t.zones ?? []).map((z) => ({
          page: z.page,
          type: z.type,
          rect: z.rect,
          index: z.index,
          sheetField: z.sheetField ?? null,
        })),
      },
    });

  return (
    <Page
      title="Repères"
      description="Les cases de la feuille de signature — créez-les, nommez-les, associez-les à vos templates."
      actions={<Button onClick={openNew}>Nouveau repère</Button>}
    >
      {error && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      {isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            title="Aucun repère"
            description="Créez-en un : il apparaîtra sur la feuille de signature et dans l'éditeur de template."
            action={<Button onClick={openNew}>Nouveau repère</Button>}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-200/70">
            {items.map((row, i) => (
              <li key={row.key} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{row.label}</span>
                    <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-normal text-ink-500">
                      {ZONE_TYPE_LABEL[row.type]}
                    </span>
                    <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-normal text-ink-500">
                      {SIZE_LABEL[row.sizeClass]}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {row.hint}
                    {row.targets.length > 0
                      ? ` · mots-clés : ${row.targets.map((t) => `« ${t} »`).join(', ')}`
                      : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>
                    ↑
                  </Button>
                  <Button variant="ghost" onClick={() => move(i, 1)} disabled={i === items.length - 1}>
                    ↓
                  </Button>
                  <Button variant="secondary" onClick={() => openEdit(row)}>
                    Modifier
                  </Button>
                  <Button variant="danger" loading={busyKey === row.key} onClick={() => del(row)}>
                    Supprimer
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {signatureFields.length > 0 && (
        <Card className="mt-5 p-5">
          <h2 className="text-sm font-semibold">Quel template signe quelle case</h2>
          <p className="mt-1 text-xs text-ink-400">
            Résolu comme au moment du placement : un choix sur la zone du template gagne, sinon le
            choix du template, sinon le mot-clé dans son nom.
          </p>
          <ul className="mt-3 space-y-3">
            {signatureFields.map((f) => {
              const matched = signatureTemplates.filter((t) => boxFor(t) === f.key);
              return (
                <li key={f.key} className="rounded-lg bg-brand-50 p-3 ring-1 ring-brand-200">
                  <p className="text-sm font-semibold text-brand-700">{f.label}</p>
                  {matched.length === 0 ? (
                    <p className="mt-1 text-xs text-ink-500">Aucun template associé.</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5 border-t border-brand-200 pt-2">
                      {matched.map((t) => {
                        const locked = zoneLockedKey(t);
                        return (
                          <li key={t.id} className="flex items-center justify-between gap-2">
                            <Link
                              to={`/templates/${t.id}`}
                              className="truncate text-xs font-medium text-ink-700 hover:underline"
                            >
                              {t.name}
                            </Link>
                            {locked ? (
                              <span
                                className="shrink-0 text-[11px] text-ink-400"
                                title="Fixé sur une zone du template — se change dans son éditeur."
                              >
                                fixé sur une zone
                              </span>
                            ) : (
                              <select
                                value={t.sheetField ?? ''}
                                onChange={(e) => reassign(t, e.target.value)}
                                className="shrink-0 rounded border border-brand-200 bg-white px-1.5 py-0.5 text-[11px] text-ink-700"
                              >
                                <option value="">Automatique — d’après le nom</option>
                                {signatureFields.map((box) => (
                                  <option key={box.key} value={box.key}>
                                    {box.label}
                                  </option>
                                ))}
                              </select>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {(() => {
            const unassigned = signatureTemplates.filter((t) => boxFor(t) === null);
            if (unassigned.length === 0) return null;
            return (
              <div className="mt-3 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
                <p className="text-xs font-semibold text-amber-700">
                  Templates sans case associée — leur signature n’ira sur aucun document
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {unassigned.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2">
                      <Link
                        to={`/templates/${t.id}`}
                        className="truncate text-xs font-medium text-ink-700 hover:underline"
                      >
                        {t.name}
                      </Link>
                      <select
                        value=""
                        onChange={(e) => reassign(t, e.target.value)}
                        className="shrink-0 rounded border border-amber-200 bg-white px-1.5 py-0.5 text-[11px] text-ink-700"
                      >
                        <option value="" disabled>
                          Associer à…
                        </option>
                        {signatureFields.map((box) => (
                          <option key={box.key} value={box.key}>
                            {box.label}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </Card>
      )}

      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Nouveau repère' : 'Modifier le repère'}
        onClose={() => setEditing(null)}
      >
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Nom"
            placeholder="Signature client"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            required
            autoFocus
          />
          <Field
            label="Nom court (bouton de l'éditeur)"
            placeholder="Signature"
            value={draft.shortLabel}
            onChange={(e) => setDraft({ ...draft, shortLabel: e.target.value })}
            required
          />
          <Field
            label="Consigne imprimée"
            placeholder="Signature du client"
            value={draft.hint}
            onChange={(e) => setDraft({ ...draft, hint: e.target.value })}
            required
          />
          <Select
            label="Type de marque"
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as ZoneType })}
          >
            {ZONE_TYPE.map((t) => (
              <option key={t} value={t}>
                {ZONE_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
          <Select
            label="Taille de la case"
            value={draft.sizeClass}
            onChange={(e) => setDraft({ ...draft, sizeClass: e.target.value as SizeClass })}
          >
            {(Object.keys(SIZE_LABEL) as SizeClass[]).map((s) => (
              <option key={s} value={s}>
                {SIZE_LABEL[s]}
              </option>
            ))}
          </Select>
          <Field
            label="Mots-clés (facultatif)"
            placeholder="devis, etude"
            value={draft.targets}
            onChange={(e) => setDraft({ ...draft, targets: e.target.value })}
            hint="Séparés par des virgules. Un template dont le nom contient l'un d'eux route ici automatiquement. Laisser vide pour un repère répété sur tous les documents (mention, tampon, date…)."
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              Enregistrer
            </Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
};
