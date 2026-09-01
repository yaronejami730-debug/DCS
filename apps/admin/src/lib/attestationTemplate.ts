/**
 * Hand a generated attestation PDF to the folder import flow.
 *
 * The operator builds an attestation, then wants to drop it straight into a
 * folder as a document to sign — without saving to disk and re-picking it. The
 * PDF is tiny (a few KB), so it rides in localStorage as base64 between the
 * attestation tab and the import dialog: "Se servir de ce modèle" writes it,
 * the import dialog offers it, and taking it clears it so it is a one-shot
 * handoff, not a stale attachment lingering on every future import.
 */
const KEY = 'scansign.attestationTemplate';

export interface StoredAttestation {
  name: string;
  /** base64, no data: prefix. */
  data: string;
  savedAt: number;
}

export const saveAttestationTemplate = (name: string, bytes: Uint8Array): void => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const payload: StoredAttestation = { name, data: btoa(binary), savedAt: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* quota or private mode — the button simply will not appear on import */
  }
};

export const peekAttestationTemplate = (): StoredAttestation | null => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredAttestation) : null;
  } catch {
    return null;
  }
};

/** Read it as a File and remove it — a one-shot handoff. */
export const takeAttestationTemplate = (): File | null => {
  const stored = peekAttestationTemplate();
  if (!stored) return null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  const binary = atob(stored.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes as BlobPart], stored.name, { type: 'application/pdf' });
};
