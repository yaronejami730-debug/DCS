import { useNavigate, useParams } from 'react-router-dom';
import { ZONE_TYPE_LABEL } from '@scansign/shared';
import { useDocumentPreview } from '../lib/queries';
import { PdfViewer } from '../components/PdfViewer';
import { BackLink, Loading, Screen } from '../components/ui';

const LEGEND = [
  ['signature', '#2f5fe0'],
  ['stamp', '#0f9d58'],
  ['mention', '#b7791f'],
] as const;

/**
 * A document, with the zones its template describes drawn on it.
 *
 * Only ever reached through an *operator* link — the account holder who scanned
 * a QR code off their own console to carry on from their phone. A signer link
 * never renders this route, and the API would refuse it anyway: an outside
 * technician has no business reading the paperwork they are signing.
 *
 * pdf.js rather than an iframe. An <iframe> of a PDF is a plugin on desktop, a
 * download prompt on some Androids, and a blank rectangle in iOS Safari — which
 * is the one browser this page is most likely to open in.
 */
export const DocumentPage = () => {
  const { token, id } = useParams<{ token: string; id: string }>();
  const navigate = useNavigate();
  const { data: preview, isLoading } = useDocumentPreview(id);

  if (isLoading) return <Loading label="Ouverture du document…" />;

  return (
    <Screen className="px-5 py-6">
      <BackLink onClick={() => navigate(`/s/${token}`)}>Retour</BackLink>

      <h1 className="mb-3 mt-2 truncate text-lg font-bold text-ink-900">
        {preview?.filename ?? 'Document'}
      </h1>

      {preview?.signed && (
        <div className="mb-2.5 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] font-semibold text-emerald-700">
          Document signé — signature et tampon appliqués
        </div>
      )}

      {preview?.annotated && (
        <div className="mb-2.5 flex flex-wrap items-center gap-3.5">
          {LEGEND.filter(([mark]) => (preview.zones[mark] ?? 0) > 0).map(([mark, colour]) => (
            <span key={mark} className="flex items-center gap-1.5">
              <span
                className="inline-block h-[11px] w-3.5 rounded-[2px] border-[1.5px] border-dashed"
                style={{ borderColor: colour }}
              />
              <span className="text-[12.5px] font-semibold text-ink-900">
                {ZONE_TYPE_LABEL[mark]}
                {preview.zones[mark] > 1 ? ` ×${preview.zones[mark]}` : ''}
              </span>
            </span>
          ))}
          <span className="ml-auto text-[11.5px] text-ink-400">Emplacements prévus</span>
        </div>
      )}

      <div className="min-h-[300px] overflow-x-auto rounded-xl">
        {preview ? (
          <PdfViewer url={preview.url} maxWidth={520} />
        ) : (
          <div className="flex h-72 items-center justify-center text-sm text-ink-400">
            Document indisponible.
          </div>
        )}
      </div>
    </Screen>
  );
};
