import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  CaptureMode,
  CutoutPreview,
  ExtractionEngine,
  NormalizedRect,
  RequiredMarks,
  ShareScope,
  SigningSession,
  SubmitRegionsInput,
  ZoneType,
} from '@scansign/shared';
import { api } from './api';

/**
 * Everything the signing app can ask the backend — and nothing more.
 *
 * The surface is short on purpose. A share link buys exactly one capability:
 * photograph a mark, check how it was cut out, submit it. There is no folder
 * query, no document list, no preview of a contract, because the person holding
 * the link is not entitled to any of that and the API refuses those routes to a
 * share token anyway. Keeping them out of the client too means the UI cannot
 * accidentally ask, and nobody reading this file is left wondering whether the
 * technician can see the paperwork. They cannot.
 *
 * The photo also travels differently from the old iPhone app: React Native
 * handed FormData a {uri,name,type} descriptor and streamed from disk, whereas
 * a browser has the bytes already, so every capture here is a real Blob.
 */

/** One of the folder's documents. Only ever present on an operator link. */
export interface IntroDocument {
  id: string;
  filename: string;
  pageCount: number;
  status: string;
}

/**
 * What the link opens onto.
 *
 * `folder` is null for a signer link and populated for an operator link — the
 * account holder who scanned a QR code off their own console. The server
 * decides that from the token's stored scope; this client never asks for one
 * or the other, it renders whichever it was given.
 */
export interface ShareIntro {
  sender: string | null;
  marks: ZoneType[];
  done: boolean;
  scope: ShareScope;
  /** The link asks for the technician's location when they return the pages. */
  requireLocation: boolean;
  /** The documents to sign — narrowed to what this link covers. */
  folder: { name: string; reference: number; documents: IntroDocument[] };
  expiresAt: string | null;
  active: boolean;
}

/**
 * The one unauthenticated call. The token is in the path because at this point
 * the page has nothing else to send.
 *
 * `retry: false` matters here: a revoked or expired link answers 403, and
 * retrying it three times only delays telling the technician why they are
 * stuck.
 */
export const useShareIntro = (token: string | undefined) =>
  useQuery({
    queryKey: ['share-intro', token],
    queryFn: () => api<ShareIntro>(`/s/${token}`, { auth: false }),
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
  });

export interface CreatedSession {
  session: SigningSession;
  marks: RequiredMarks;
  /** Null in per-mark mode: each photo is uploaded separately afterwards. */
  photo: { url: string; width: number; height: number } | null;
  /** Where the backend thinks the ink is. Advisory: the user still confirms. */
  suggestions?: { signature: NormalizedRect | null; stamp: NormalizedRect | null } | null;
}

/**
 * Start a session.
 *
 * In `single` mode the sheet is uploaded here; in `per_mark` mode the session
 * opens empty and each mark is photographed in turn.
 */
export const useStartSession = () =>
  useMutation({
    mutationFn: ({ captureMode, photo }: { captureMode: CaptureMode; photo?: Blob }) => {
      const form = new FormData();
      if (photo) form.append('photo', photo, 'capture.jpg');
      // No folder in the path: the backend reads it off the share token, so a
      // folder id never has to travel to a client that is not allowed to use
      // it for anything else.
      return api<CreatedSession>(`/signing-sessions?captureMode=${captureMode}`, {
        method: 'POST',
        form,
      });
    },
  });

export interface MarkPhotoResult {
  session: SigningSession;
  mark: ZoneType;
  photo: { url: string; width: number; height: number };
  suggestion: NormalizedRect | null;
}

/** Per-mark capture: upload the photo of one mark. */
export const useUploadMarkPhoto = () =>
  useMutation({
    mutationFn: ({ sessionId, mark, photo }: { sessionId: string; mark: ZoneType; photo: Blob }) => {
      const form = new FormData();
      form.append('photo', photo, `${mark}.jpg`);
      return api<MarkPhotoResult>(`/signing-sessions/${sessionId}/photo/${mark}`, {
        method: 'POST',
        form,
      });
    },
  });

/**
 * Ask what the extraction engine will make of a region before committing.
 *
 * Background removal is the step most likely to disappoint, and the photo alone
 * gives the signer no way to judge it. The cutout is their own ink, so there is
 * nothing here they are not entitled to see.
 */
export const usePreviewCutout = () =>
  useMutation({
    mutationFn: ({
      sessionId,
      mark,
      region,
      engine = 'local',
    }: {
      sessionId: string;
      mark: ZoneType;
      region: NormalizedRect;
      engine?: ExtractionEngine;
    }) =>
      api<CutoutPreview>(`/signing-sessions/${sessionId}/preview-cutout`, {
        method: 'POST',
        json: { mark, region, engine },
      }),
  });

/**
 * Submit the framed marks.
 *
 * No `assignments`: choosing which variant of a signature lands on which
 * document would mean showing the technician a list of documents, which is
 * precisely what a share link must not do. The backend distributes one variant
 * per document by position instead — the same spread the signer would have
 * produced, decided somewhere they are allowed to decide it.
 */
export const useSubmitRegions = () =>
  useMutation({
    mutationFn: ({
      sessionId,
      regions,
    }: {
      sessionId: string;
      regions: Omit<SubmitRegionsInput, 'assignments'>;
    }) =>
      api<SigningSession>(`/signing-sessions/${sessionId}/regions`, {
        method: 'POST',
        json: regions,
      }),
  });

/**
 * Poll a session while it is still moving.
 *
 * `completed` and `error` are terminal: nothing will change again, so the
 * interval stops there. Left unconditional it kept hitting the API every 1.5s
 * for as long as the screen stayed open, long after the outcome was decided.
 */
export const useSession = (sessionId: string | undefined, poll: boolean) =>
  useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api<SigningSession>(`/signing-sessions/${sessionId}`),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      if (!poll) return false;
      const status = query.state.data?.status;
      return status === 'completed' || status === 'error' ? false : 1500;
    },
  });

export interface ImportedDocument {
  filename: string;
  pageCount: number;
}

/**
 * Send a PDF back into the folder the link points at.
 *
 * The technician is often the one holding the paperwork — a delivery note, a
 * signed annex, a form filled in on site — so the link works in both
 * directions: a signature goes back, and so can a document.
 *
 * The response is a receipt for these files only. Nothing about the folder
 * comes back, because uploading into it is not the same as being allowed to
 * read it.
 */
export const useImportDocuments = () =>
  useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      return api<{ imported: ImportedDocument[] }>('/link/documents', {
        method: 'POST',
        form,
      });
    },
  });

export interface DocumentPreview {
  url: string;
  filename: string;
  /** True when the PDF shows the template's zones — never once signed. */
  annotated: boolean;
  /** True when this is the finished document, marks and all. */
  signed: boolean;
  zones: Record<ZoneType, number>;
}

/**
 * The document with its zones drawn on it, so the operator can check the
 * placement before committing to a photo.
 *
 * Only reachable with an operator link. A signer token gets a 403 from the API,
 * which is why nothing in the signing flow calls this — the screen that uses it
 * is not rendered for them at all.
 */
export const useDocumentPreview = (documentId: string | undefined) =>
  useQuery({
    queryKey: ['document-preview', documentId],
    queryFn: () => api<DocumentPreview>(`/documents/${documentId}/preview-url`),
    enabled: Boolean(documentId),
    // Signed URLs expire; refresh well before the server's 15 minute window.
    staleTime: 10 * 60 * 1000,
  });

/**
 * A short-lived link to one of the documents, so it can be opened or printed.
 *
 * This is the first half of the loop: the technician downloads the PDF, prints
 * it, signs it by hand. The API allows it only for documents this link covers.
 */
export const documentUrl = (documentId: string) =>
  api<{ url: string; filename: string }>(`/documents/${documentId}/original-url`);

/**
 * Send the signed page back.
 *
 * The second half of the loop. What goes up is whatever the technician's phone
 * or copier produced — a photo of the page, or a multi-page PDF scan. Nobody
 * decides what is in it here; the operator crops the marks out of it on the
 * console afterwards.
 */
export const useSendSignedScan = () =>
  useMutation({
    mutationFn: ({
      files,
      documentId,
      location,
    }: {
      files: File[];
      documentId?: string | null;
      /** Consented coordinates, when the link asked and the technician allowed. */
      location?: { latitude: number; longitude: number; accuracy: number | null } | null;
    }) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      if (documentId) form.append('documentId', documentId);
      if (location) form.append('location', JSON.stringify(location));
      return api<{ returned: Array<{ id: string; filename: string }> }>('/link/returns', {
        method: 'POST',
        form,
      });
    },
  });
