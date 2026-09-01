import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFolder } from '../lib/queries';
import { Page } from '../components/Layout';
import { PdfViewer } from '../components/PdfViewer';
import { Button, Card, Field, Modal } from '../components/ui';
import {
  generateAttestationPdf,
  type AttestationDoc,
  type AttestationSigner,
} from '../lib/attestationPdf';
import { saveAttestationTemplate } from '../lib/attestationTemplate';

const TYPES = ['Devis', 'Facture', "Attestation sur l'honneur", 'Mandat ou autorisation', 'Autre document'];

/**
 * The three real-world groupings. Each card drops its documents in at once,
 * pre-configured: what the signer applies, and whether the signature varies.
 * 'même signature avec variantes' → signature on (the pipeline varies it per
 * document); 'tampon' → stamp on too.
 */
const PRESETS: {
  key: string;
  title: string;
  note: string;
  docs: AttestationDoc[];
}[] = [
  {
    key: 'devis',
    title: 'Devis & Études',
    note: 'Même date, regroupés',
    docs: [
      { type: 'Devis', concerned: '', showApproval: true, wantSignature: true, wantStamp: false, combined: false },
      { type: "Documents d'étude", concerned: '', showApproval: true, wantSignature: true, wantStamp: false, combined: false },
    ],
  },
  {
    key: 'ah',
    title: 'AH & Stockage',
    note: 'Même signature, avec variantes',
    docs: [
      { type: 'AH', concerned: '', showApproval: true, wantSignature: true, wantStamp: false, combined: false },
      { type: 'Attestation de stockage', concerned: '', showApproval: true, wantSignature: true, wantStamp: false, combined: false },
    ],
  },
  {
    key: 'install',
    title: 'Installation & Fin d’installation',
    note: 'Même signature, avec variantes · tampon',
    docs: [
      { type: 'Installation', concerned: '', showApproval: true, wantSignature: true, wantStamp: true, combined: false },
      { type: "Attestation de fin d'installation", concerned: '', showApproval: true, wantSignature: true, wantStamp: true, combined: false },
    ],
  },
];

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
    { type: 'Devis', concerned: '', showApproval: true, wantSignature: true, wantStamp: true, combined: false },
  ]);
  const [newType, setNewType] = useState<string>(TYPES[0]!);
  const [busy, setBusy] = useState(false);
  /** Row being edited in the modal — opened for 'Autre document' or via Éditer. */
  const [editing, setEditing] = useState<number | null>(null);

  const seededFolder = folder?.name;
  const seedFromFolder = () => {
    const seeded = (folder?.documents ?? [])
      .filter((d) => d.role !== 'for_signing')
      .map<AttestationDoc>((d) => ({ type: 'Autre document', concerned: d.filename, showApproval: true, wantSignature: true, wantStamp: true, combined: false }));
    if (seeded.length > 0) setDocs(seeded);
  };

  const setDoc = (i: number, patch: Partial<AttestationDoc>) =>
    setDocs((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const fileName = () =>
    `attestation-${(signer.company || 'accord').replace(/\s+/g, '-').toLowerCase()}.pdf`;

  const generate = async () => {
    setBusy(true);
    try {
      const bytes = await generateAttestationPdf(signer, docs);
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  // Live preview: rebuild the PDF as the operator edits, so the left pane shows
  // exactly what will be generated. Debounced — pdf-lib is fast, but pdf.js
  // re-rendering on every keystroke is not worth it.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const bytes = await generateAttestationPdf(signer, docs);
        if (cancelled) return;
        const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreviewUrl(url);
      } catch {
        /* a transient bad state while typing — keep the last good preview */
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signer, docs]);
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  const [saved, setSaved] = useState(false);

  // The preview PDF must fit its column, which is full-width on a phone and a
  // half on desktop. Measured rather than a fixed 480, which was clipped on
  // mobile.
  const previewBox = useRef<HTMLDivElement>(null);
  const [previewW, setPreviewW] = useState(480);
  useLayoutEffect(() => {
    const el = previewBox.current;
    if (!el) return;
    const measure = () => setPreviewW(Math.max(200, el.clientWidth - 24));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const useAsTemplate = async () => {
    setBusy(true);
    try {
      const bytes = await generateAttestationPdf(signer, docs);
      saveAttestationTemplate(fileName(), bytes);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Attestation simplifiée"
      description="Renseignez le signataire et les documents, puis générez le PDF."
      actions={
        <>
          <Button
            variant="secondary"
            loading={busy}
            disabled={docs.length === 0}
            onClick={() => void useAsTemplate()}
          >
            {saved ? 'Prêt à importer ✓' : 'Se servir de ce modèle'}
          </Button>
          <Button loading={busy} disabled={docs.length === 0} onClick={() => void generate()}>
            Générer le PDF
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Aperçu vivant du PDF (gauche) */}
        <div className="order-2 lg:order-1 lg:sticky lg:top-4 lg:self-start">
          <div
            ref={previewBox}
            className="max-h-[60vh] overflow-auto rounded-xl bg-ink-100 p-3 ring-1 ring-ink-200/70 lg:max-h-[calc(100vh-150px)]"
          >
            {previewUrl ? (
              <PdfViewer url={previewUrl} maxWidth={previewW} />
            ) : (
              <p className="py-16 text-center text-sm text-ink-400">Préparation de l’aperçu…</p>
            )}
          </div>
        </div>

        {/* Éditeur (droite sur desktop, en premier sur mobile) */}
        <div className="order-1 space-y-5 lg:order-2">
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Modèles rapides</h2>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() =>
                  setDocs((prev) => [...prev, ...preset.docs.map((d) => ({ ...d }))])
                }
                className="rounded-xl bg-brand-50 p-3 text-left ring-1 ring-brand-200 transition hover:bg-brand-100"
              >
                <p className="text-sm font-semibold text-brand-700">{preset.title}</p>
                <ul className="mt-1.5 space-y-0.5">
                  {preset.docs.map((d) => (
                    <li key={d.type} className="text-xs text-ink-600">
                      • {d.type}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-ink-400">{preset.note}</p>
              </button>
            ))}
          </div>
          <p className="mt-2.5 text-xs text-ink-400">
            Un clic ajoute les documents du modèle, préconfigurés. Vous pouvez ensuite ajuster.
          </p>
        </Card>

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
                    value={TYPES.includes(doc.type) ? doc.type : 'Autre document'}
                    onChange={(e) => {
                      if (e.target.value === 'Autre document') {
                        setDoc(i, { type: doc.type && !TYPES.includes(doc.type) ? doc.type : '' });
                        setEditing(i);
                      } else {
                        setDoc(i, { type: e.target.value });
                      }
                    }}
                    className="rounded-lg bg-white px-2.5 py-1.5 text-sm ring-1 ring-ink-200 outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  {!TYPES.includes(doc.type) && doc.type && (
                    <span className="truncate text-xs font-medium text-ink-700">« {doc.type} »</span>
                  )}
                  <button
                    onClick={() => setEditing(i)}
                    className="text-xs font-medium text-brand-600 hover:underline"
                  >
                    Éditer
                  </button>
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
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-600">
                    <input
                      type="checkbox"
                      checked={doc.wantSignature}
                      onChange={(e) =>
                        setDoc(i, {
                          wantSignature: e.target.checked,
                          // Never leave a box asking for nothing.
                          wantStamp: e.target.checked ? doc.wantStamp : true,
                        })
                      }
                      className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                    />
                    Signature manuscrite
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-600">
                    <input
                      type="checkbox"
                      checked={doc.wantStamp}
                      onChange={(e) =>
                        setDoc(i, {
                          wantStamp: e.target.checked,
                          wantSignature: e.target.checked ? doc.wantSignature : true,
                        })
                      }
                      className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                    />
                    Cachet de la société
                  </label>
                  {doc.wantSignature && doc.wantStamp && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-600">
                      <input
                        type="checkbox"
                        checked={doc.combined}
                        onChange={(e) => setDoc(i, { combined: e.target.checked })}
                        className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                      />
                      Ensemble
                    </label>
                  )}
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-600">
                    <input
                      type="checkbox"
                      checked={doc.showApproval}
                      onChange={(e) => setDoc(i, { showApproval: e.target.checked })}
                      className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                    />
                    « Lu et approuvé, bon pour accord »
                  </label>
                </div>
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
              onClick={() => {
                const isOther = newType === 'Autre document';
                setDocs((prev) => [
                  ...prev,
                  {
                    type: isOther ? '' : newType,
                    concerned: '',
                    showApproval: false,
                    wantSignature: true,
                    wantStamp: true,
                    combined: false,
                  },
                ]);
                if (isOther) setEditing(docs.length);
              }}
            >
              Ajouter ce document
            </Button>
          </div>
        </Card>
        </div>
      </div>

      <Modal
        open={editing !== null}
        title="Éditer le document"
        onClose={() => setEditing(null)}
      >
        {editing !== null && docs[editing] && (
          <div className="space-y-4">
            <Field
              label="Nom du document"
              value={docs[editing]!.type}
              onChange={(e) => setDoc(editing, { type: e.target.value })}
              placeholder="Ex. Bon de commande, PV de réception…"
            />
            <Field
              label="Document concerné"
              value={docs[editing]!.concerned}
              onChange={(e) => setDoc(editing, { concerned: e.target.value })}
              placeholder="Ex. Devis n° 1048"
            />
            <div>
              <span className="mb-1.5 block text-sm font-medium text-ink-800">
                À faire apparaître dans la zone
              </span>
              <div className="space-y-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={docs[editing]!.wantSignature}
                    onChange={(e) =>
                      setDoc(editing, {
                        wantSignature: e.target.checked,
                        wantStamp: e.target.checked ? docs[editing]!.wantStamp : true,
                      })
                    }
                    className="h-4 w-4 rounded border-ink-300 accent-brand-600"
                  />
                  Signature manuscrite du dirigeant
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={docs[editing]!.wantStamp}
                    onChange={(e) =>
                      setDoc(editing, {
                        wantStamp: e.target.checked,
                        wantSignature: e.target.checked ? docs[editing]!.wantSignature : true,
                      })
                    }
                    className="h-4 w-4 rounded border-ink-300 accent-brand-600"
                  />
                  Cachet de la société
                </label>
                <label
                  className={`flex items-center gap-2 text-sm ${
                    docs[editing]!.wantSignature && docs[editing]!.wantStamp
                      ? 'cursor-pointer text-ink-700'
                      : 'cursor-not-allowed text-ink-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={!(docs[editing]!.wantSignature && docs[editing]!.wantStamp)}
                    checked={docs[editing]!.combined}
                    onChange={(e) => setDoc(editing, { combined: e.target.checked })}
                    className="h-4 w-4 rounded border-ink-300 accent-brand-600"
                  />
                  Signature et cachet ensemble (au même endroit)
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={docs[editing]!.showApproval}
                    onChange={(e) => setDoc(editing, { showApproval: e.target.checked })}
                    className="h-4 w-4 rounded border-ink-300 accent-brand-600"
                  />
                  Mention « Lu et approuvé, bon pour accord »
                </label>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  if (!docs[editing]!.type.trim()) setDoc(editing, { type: 'Autre document' });
                  setEditing(null);
                }}
              >
                Terminer
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <p className="mt-4 max-w-3xl text-xs leading-5 text-ink-400">
        Signature manuscrite, non électronique : le dirigeant signe à la main sur l’attestation.
        Chaque signature peut ensuite être reproduite uniquement sur le document auquel elle
        correspond, avec son accord exprès. Cette attestation ne remplace pas une formalité
        obligatoire propre à certains documents ou secteurs.
      </p>
    </Page>
  );
};
