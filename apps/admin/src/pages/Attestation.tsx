import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFolder } from '../lib/queries';
import { Page } from '../components/Layout';
import { Button, Card, Field, Select } from '../components/ui';
import {
  generateAttestationPdf,
  type AttestationDoc,
  type AttestationSigner,
} from '../lib/attestationPdf';

const TYPES = ['Devis', 'Facture', "Attestation sur l'honneur", 'Mandat ou autorisation', 'Autre document'];

/**
 * Generate the attestation PDF from a plain console form.
 *
 * No embedded editor, no print dialog: the operator fills fields the way they
 * fill every other form here, and one button produces a PDF file to save or
 * send. When opened for a folder (?folder=), the documents to sign seed the
 * list, so the common path is "open, glance, generate".
 */
export const AttestationPage = () => {
  const [params] = useSearchParams();
  const folderId = params.get('folder') ?? undefined;
  const { data: folder } = useFolder(folderId);

  const [signer, setSigner] = useState<AttestationSigner>({
    name: '',
    quality: '',
    company: '',
    siren: '',
  });
  const [docs, setDocs] = useState<AttestationDoc[]>([
    { type: 'Devis', concerned: '', showApproval: true },
  ]);
  const [newType, setNewType] = useState<string>(TYPES[0]!);
  const [busy, setBusy] = useState(false);

  const seededFolder = folder?.name;
  const seedFromFolder = () => {
    const seeded = (folder?.documents ?? [])
      .filter((d) => d.role !== 'for_signing')
      .map<AttestationDoc>((d) => ({ type: 'Autre document', concerned: d.filename, showApproval: true }));
    if (seeded.length > 0) setDocs(seeded);
  };

  const setDoc = (i: number, patch: Partial<AttestationDoc>) =>
    setDocs((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const generate = async () => {
    setBusy(true);
    try {
      const bytes = await generateAttestationPdf(signer, docs);
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attestation-${(signer.company || 'accord').replace(/\s+/g, '-').toLowerCase()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Attestation simplifiée"
      description="Renseignez le signataire et les documents, puis générez le PDF."
      actions={
        <Button loading={busy} disabled={docs.length === 0} onClick={() => void generate()}>
          Générer le PDF
        </Button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* Signataire */}
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Le signataire</h2>
          <div className="space-y-3">
            <Field
              label="Je soussigné(e) M./Mme"
              value={signer.name}
              onChange={(e) => setSigner({ ...signer, name: e.target.value })}
              placeholder="Marie Dupont"
            />
            <Field
              label="Qualité du dirigeant"
              value={signer.quality}
              onChange={(e) => setSigner({ ...signer, quality: e.target.value })}
              placeholder="Gérante"
            />
            <Field
              label="Pour la société"
              value={signer.company}
              onChange={(e) => setSigner({ ...signer, company: e.target.value })}
              placeholder="Renov Énergie SARL"
            />
            <Field
              label="SIREN ou SIRET"
              value={signer.siren}
              onChange={(e) => setSigner({ ...signer, siren: e.target.value })}
              placeholder="123 456 789"
            />
          </div>
        </Card>

        {/* Documents */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Documents ({docs.length})</h2>
            {seededFolder && (
              <button
                onClick={seedFromFolder}
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                Reprendre ceux de « {seededFolder} »
              </button>
            )}
          </div>

          <div className="space-y-2.5">
            {docs.map((doc, i) => (
              <div key={i} className="rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200/70">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-brand-600">{i + 1}.</span>
                  <select
                    value={doc.type}
                    onChange={(e) => setDoc(i, { type: e.target.value })}
                    className="rounded-lg bg-white px-2.5 py-1.5 text-sm ring-1 ring-ink-200 outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setDocs((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-auto text-xs font-medium text-red-600 hover:underline"
                  >
                    Retirer
                  </button>
                </div>
                <input
                  type="text"
                  value={doc.concerned}
                  onChange={(e) => setDoc(i, { concerned: e.target.value })}
                  placeholder="Document concerné (ex. Devis n° 1048)"
                  className="mt-2 w-full rounded-lg bg-white px-2.5 py-1.5 text-sm ring-1 ring-ink-200 outline-none focus:ring-2 focus:ring-brand-500"
                />
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-ink-600">
                  <input
                    type="checkbox"
                    checked={doc.showApproval}
                    onChange={(e) => setDoc(i, { showApproval: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                  />
                  Afficher la mention « Lu et approuvé »
                </label>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-ink-200/70 pt-3">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="rounded-lg bg-white px-2.5 py-2 text-sm ring-1 ring-ink-200 outline-none focus:ring-2 focus:ring-brand-500"
            >
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              onClick={() =>
                setDocs((prev) => [...prev, { type: newType, concerned: '', showApproval: false }])
              }
            >
              Ajouter ce document
            </Button>
          </div>
        </Card>
      </div>

      <p className="mt-4 max-w-3xl text-xs leading-5 text-ink-400">
        Signature manuscrite, non électronique : le dirigeant signe à la main sur l’attestation.
        Chaque signature peut ensuite être reproduite uniquement sur le document auquel elle
        correspond, avec son accord exprès. Cette attestation ne remplace pas une formalité
        obligatoire propre à certains documents ou secteurs.
      </p>
    </Page>
  );
};
