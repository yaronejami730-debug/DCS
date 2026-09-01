import { useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFolder } from '../lib/queries';
import { Page } from '../components/Layout';
import { Button } from '../components/ui';

/**
 * The standalone attestation editor, hosted inside the console.
 *
 * The tool is a self-contained HTML file in /public — it owns its own layout,
 * its A4 print CSS and its window.print(), which is exactly why it prints
 * cleanly: an iframe printed on its own carries none of the console's nav or
 * chrome. Embedding it rather than reimplementing it in React keeps one source
 * of truth for the document, and the same file works opened directly.
 *
 * Same-origin (served from this app), so the parent can call into it: when the
 * page is opened for a folder, its "documents à faire signer" are pushed in as
 * starting rows via the tool's own window.setDocuments.
 */
export const AttestationPage = () => {
  const [params] = useSearchParams();
  const folderId = params.get('folder') ?? undefined;
  const { data: folder } = useFolder(folderId);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const prefill = () => {
    const win = frameRef.current?.contentWindow as
      | (Window & { setDocuments?: (d: unknown[]) => void })
      | null
      | undefined;
    if (!win?.setDocuments) return;
    const docs = (folder?.documents ?? [])
      .filter((d) => d.role !== 'for_signing')
      .map((d) => ({ type: 'Autre document', concerned: d.filename, showApproval: true }));
    if (docs.length > 0) win.setDocuments(docs);
  };

  return (
    <Page
      title="Attestation simplifiée"
      description="Générez une attestation d’accord imprimable — une page par document."
      actions={
        folder ? (
          <Button variant="secondary" onClick={prefill}>
            Pré-remplir depuis « {folder.name} »
          </Button>
        ) : null
      }
    >
      <div className="overflow-hidden rounded-xl bg-white ring-1 ring-ink-200/70">
        <iframe
          ref={frameRef}
          title="Attestation simplifiée"
          src="/attestation_simplifiee_dynamique.html"
          className="h-[calc(100vh-190px)] w-full border-0"
          onLoad={() => {
            // Auto-prefill when arriving from a folder, so the operator lands
            // on their own documents rather than an empty example.
            if (folderId) prefill();
          }}
        />
      </div>
    </Page>
  );
};
