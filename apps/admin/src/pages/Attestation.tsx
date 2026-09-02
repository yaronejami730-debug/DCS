import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ATTESTATION_SHEET_V1, ZONE_TYPE_LABEL } from '@scansign/shared';
import { useFolder } from '../lib/queries';
import { Page } from '../components/Layout';
import { PdfViewer } from '../components/PdfViewer';
import { Button, Card, Field } from '../components/ui';
import { generateAttestationPdf, type AttestationSigner } from '../lib/attestationPdf';
import { saveAttestationTemplate } from '../lib/attestationTemplate';

/**
 * Generate the attestation PDF from a plain console form.
 *
 * The document is fixed in shape: an identity page, then the capture sheet —
 * three signature boxes (one per group of documents), the handwritten mention,
 * the manager's name, the quote date — each framed by printed markers the
 * system reads back automatically. The operator only fills in who signs and,
 * optionally, what for. When opened for a folder (?folder=), the folder's name
 * seeds the operation.
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
  const [concerned, setConcerned] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the operation from the folder once, if the operator has typed nothing.
  const seeded = useRef(false);
  useEffect(() => {
    if (folder?.name && !seeded.current && concerned === '') {
      seeded.current = true;
      setConcerned(folder.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.name]);

  const fileName = () =>
    `attestation-${(signer.company || 'accord').replace(/\s+/g, '-').toLowerCase()}.pdf`;

  const build = () => generateAttestationPdf(signer, { concerned: concerned.trim() || undefined });

  const generate = async () => {
    setBusy(true);
    try {
      const bytes = await build();
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

  const useAsTemplate = async () => {
    setBusy(true);
    try {
      saveAttestationTemplate(fileName(), await build());
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
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
        const bytes = await build();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, concerned]);
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

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

  const signatureBoxes = ATTESTATION_SHEET_V1.fields.filter((f) => f.type === 'signature');
  const otherBoxes = ATTESTATION_SHEET_V1.fields.filter((f) => f.type !== 'signature');

  return (
    <Page
      title="Attestation simplifiée"
      description="Renseignez le signataire, puis générez le PDF : la feuille de signature est lue automatiquement au retour."
      actions={
        <>
          <Button variant="secondary" loading={busy} onClick={() => void useAsTemplate()}>
            {saved ? 'Prêt à importer ✓' : 'Se servir de ce modèle'}
          </Button>
          <Button loading={busy} onClick={() => void generate()}>
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
              <Field
                label="Opération concernée"
                value={concerned}
                onChange={(e) => setConcerned(e.target.value)}
                placeholder="Ex. Chantier 12 rue des Lilas"
                hint="Facultatif. Repris sur la première page."
              />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 text-sm font-semibold">La feuille de signature</h2>
            <p className="mb-4 text-xs text-ink-400">
              Page 2 du PDF. Chaque case est encadrée de repères imprimés : au retour du scan, le
              système la retrouve seul et la reporte sur les documents qu’elle désigne.
            </p>

            <p className="text-xs font-bold uppercase tracking-wide text-ink-400">
              Trois cases de signature, une par groupe de documents
            </p>
            <ul className="mt-2 space-y-2">
              {signatureBoxes.map((f, i) => (
                <li key={f.id} className="rounded-lg bg-brand-50 p-3 ring-1 ring-brand-200">
                  <p className="text-sm font-semibold text-brand-700">
                    {i + 1}. {f.label}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-600">
                    {f.hint} · va sur les templates dont le nom contient :{' '}
                    {f.targets.map((t) => `« ${t} »`).join(', ')}
                  </p>
                </li>
              ))}
            </ul>

            <p className="mt-4 text-xs font-bold uppercase tracking-wide text-ink-400">
              Écrites une fois, reprises sur chaque document
            </p>
            <ul className="mt-2 space-y-1.5">
              {otherBoxes.map((f) => (
                <li key={f.id} className="flex items-baseline gap-2 text-sm">
                  <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-600">
                    {ZONE_TYPE_LABEL[f.type]}
                  </span>
                  <span className="text-ink-700">{f.hint}</span>
                </li>
              ))}
            </ul>

            <p className="mt-4 text-xs text-ink-400">
              Un template dont le nom ne dit pas son groupe peut désigner sa case dans son éditeur
              (« Case de signature sur la feuille »).
            </p>
          </Card>
        </div>
      </div>

      <p className="mt-4 max-w-3xl text-xs leading-5 text-ink-400">
        Signature manuscrite, non électronique : le dirigeant signe à la main sur l’attestation.
        Chaque signature peut ensuite être reproduite uniquement sur les documents auxquels elle
        correspond, avec son accord exprès. Cette attestation ne remplace pas une formalité
        obligatoire propre à certains documents ou secteurs.
      </p>
    </Page>
  );
};
