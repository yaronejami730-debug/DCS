import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ATTESTATION_SHEET_V1, sheetFieldTargetsDocument } from '@scansign/shared';
import {
  downloadTemplatePdf,
  useCreateTemplateFromPdf,
  useDeleteTemplate,
  useTemplates,
} from '../lib/queries';
import { ApiRequestError } from '../lib/api';
import { Page } from '../components/Layout';
import { Button, Card, EmptyState, Field, Modal, Select, Spinner, formatDate } from '../components/ui';

/**
 * The documents the capture sheet expects a template for.
 *
 * The sheet's three signature boxes each sign a group of documents. For the
 * sheet to route a returned signature, one template per document must exist,
 * carry a signature zone, and be tied to its box — by keyword in its name or
 * explicitly. This list is the checklist: each row says which box signs it,
 * whether a template already answers, and offers to create the missing one
 * with the name and the box already filled in.
 */
const EXPECTED_TEMPLATES: Array<{ name: string; fieldId: string }> = [
  { name: 'Devis', fieldId: 'signature_1' },
  { name: 'Étude', fieldId: 'signature_1' },
  { name: 'Absence de tampon', fieldId: 'signature_1' },
  { name: 'AH', fieldId: 'signature_2' },
  { name: 'Attestation de stockage', fieldId: 'signature_2' },
  { name: "Attestation de fin d'installation", fieldId: 'signature_3' },
  { name: "Attestation d'installation", fieldId: 'signature_3' },
];

export const TemplatesPage = () => {
  // One-off configurations are hidden by default — that is the whole point of
  // the distinction — but they stay one click away, so nothing an operator
  // configured ever becomes unreachable.
  const [showOneOff, setShowOneOff] = useState(false);
  const { data, isLoading } = useTemplates(showOneOff);
  const remove = useDeleteTemplate();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const create = useCreateTemplateFromPdf();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [sheetField, setSheetField] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [showExpected, setShowExpected] = useState(true);

  const signatureBoxes = ATTESTATION_SHEET_V1.fields.filter((f) => f.type === 'signature');
  const boxTitle = (id: string) => signatureBoxes.find((f) => f.id === id)?.label ?? id;

  /** Open the creation form with a row of the checklist already filled in. */
  const startExpected = (expected: { name: string; fieldId: string }) => {
    setName(expected.name);
    setSheetField(expected.fieldId);
    setFile(null);
    setCreating(true);
  };

  /**
   * Does an existing template answer this row? By explicit box first; else by
   * the sheet's own keyword rule on the template's name — the same rule the
   * crop screen applies, so what shows green here routes there.
   */
  const templateFor = (expected: { name: string; fieldId: string }) => {
    const field = signatureBoxes.find((f) => f.id === expected.fieldId);
    const items = data?.items ?? [];
    return items.find((t) => {
      const zoneBox = t.zones?.find((z) => z.type === 'signature' && z.sheetField)?.sheetField;
      const chosen = zoneBox ?? t.sheetField;
      if (chosen) return chosen === expected.fieldId && sheetFieldTargetsDocument({ targets: [expected.name] }, [t.name]) ;
      return field ? sheetFieldTargetsDocument(field, [t.name]) && sheetFieldTargetsDocument({ targets: [expected.name] }, [t.name]) : false;
    });
  };

  /** Name it, give it the PDF it describes, then place the zones. */
  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setError(null);
    create.mutate(
      { name, file, sheetField: sheetField || null },
      {
        onSuccess: (template) => {
          setCreating(false);
          setName('');
          setSheetField('');
          setFile(null);
          navigate(`/templates/${template.id}`);
        },
        onError: (e) =>
          setError(e instanceof ApiRequestError ? e.message : 'Création impossible.'),
      },
    );
  };

  const download = async (id: string) => {
    setDownloading(id);
    setError(null);
    try {
      await downloadTemplatePdf(id);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Téléchargement impossible.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Page
      title="Templates"
      description="Un template décrit où placer la signature, le tampon et la mention dans un type de document."
      actions={
        <>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={showOneOff}
              onChange={(e) => setShowOneOff(e.target.checked)}
              className="h-4 w-4 rounded border-ink-200 accent-brand-600"
            />
            Afficher aussi les configurations à usage unique
          </label>
          <Button onClick={() => setCreating(true)}>Nouveau template</Button>
        </>
      }
    >
      {error && (
        <Card className="mb-4 border-l-4 border-l-red-500 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      <Card className="mb-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Templates attendus par la feuille de signature</h2>
            <p className="mt-1 text-xs text-ink-400">
              L’attestation simplifiée porte trois cases de signature, une par groupe de documents.
              Pour que chaque case aille au bon endroit, il faut un template par document, avec
              une zone de signature, rattaché à sa case (par son nom, ou explicitement).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowExpected((v) => !v)}
            className="shrink-0 text-xs font-medium text-brand-600 hover:underline"
          >
            {showExpected ? 'Masquer' : 'Afficher'}
          </button>
        </div>
        {showExpected && (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {EXPECTED_TEMPLATES.map((expected) => {
              const existing = templateFor(expected);
              const hasSignature = existing?.zones?.some((z) => z.type === 'signature') ?? false;
              const tone = !existing
                ? 'ring-ink-200 bg-white'
                : hasSignature
                  ? 'ring-emerald-200 bg-emerald-50'
                  : 'ring-amber-200 bg-amber-50';
              return (
                <li key={expected.name} className={`rounded-lg p-3 ring-1 ${tone}`}>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span>{!existing ? '○' : hasSignature ? '✅' : '⚠️'}</span>
                    <span className="truncate">{expected.name}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    Case : {boxTitle(expected.fieldId)}
                  </p>
                  <div className="mt-2">
                    {!existing ? (
                      <Button variant="secondary" onClick={() => startExpected(expected)}>
                        Créer ce template
                      </Button>
                    ) : (
                      <Link to={`/templates/${existing.id}`}>
                        <Button variant="secondary">
                          {hasSignature ? 'Ouvrir' : 'Ajouter la zone de signature'}
                        </Button>
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Aucun template"
            description="Créez-en un : donnez-lui un nom, ajoutez le PDF qu’il décrit, puis placez les zones. Configurer les zones d’un document ne crée pas de template : cochez « Réutilisable » pour cela."
            action={<Button onClick={() => setCreating(true)}>Nouveau template</Button>}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-200/70">
            {data!.items.map((template) => {
              const signatures = template.zones?.filter((z) => z.type === 'signature').length ?? 0;
              const stamps = template.zones?.filter((z) => z.type === 'stamp').length ?? 0;
              const mentions = template.zones?.filter((z) => z.type === 'mention').length ?? 0;
              const combined =
                template.zones?.filter((z) => z.type === 'signature_stamp').length ?? 0;
              return (
                <li key={template.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{template.name}</span>
                      {!template.reusable && (
                        <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-normal text-ink-500">
                          usage unique
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {signatures} signature(s) · {stamps} tampon(s)
                      {mentions > 0 ? ` · ${mentions} mention(s)` : ''}
                      {combined > 0 ? ` · ${combined} tampon+signature` : ''}
                      {template.pageCount ? ` · ${template.pageCount} page(s)` : ''}
                      {template.documentHash ? ' · reconnu par empreinte' : ' · sans empreinte'} ·
                      modifié le {formatDate(template.updatedAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      loading={downloading === template.id}
                      onClick={() => void download(template.id)}
                    >
                      Télécharger le PDF
                    </Button>
                    <Link to={`/templates/${template.id}`}>
                      <Button variant="secondary">Ouvrir</Button>
                    </Link>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Supprimer le template « ${template.name} » ?`)) {
                          remove.mutate(template.id);
                        }
                      }}
                    >
                      Supprimer
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <Modal open={creating} title="Nouveau template" onClose={() => setCreating(false)}>
        <form onSubmit={submitNew} className="space-y-4">
          <Field
            label="Nom du template"
            placeholder="Devis"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            hint="Ce que décrit ce template : Devis, Contrat de vente, Mandat…"
          />

          <Select
            label="Case de signature sur la feuille"
            value={sheetField}
            onChange={(e) => setSheetField(e.target.value)}
          >
            <option value="">Automatique — d’après le nom</option>
            {signatureBoxes.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-800">Document modèle</span>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <Button variant="secondary" type="button" onClick={() => fileInput.current?.click()}>
              {file ? 'Changer de PDF' : 'Choisir un PDF'}
            </Button>
            {file && <p className="mt-2 text-xs text-ink-600">{file.name}</p>}
            <p className="mt-1 text-xs text-ink-400">
              Un exemplaire vierge du document. Vous placerez les zones dessus à l’étape suivante.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setCreating(false)}>
              Annuler
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!file || !name.trim()}>
              Continuer
            </Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
};
