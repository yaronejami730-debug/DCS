import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CaptureMode,
  CutoutPreview,
  GeneratedVariant,
  MarkAssignments,
  Document,
  Folder,
  NormalizedRect,
  Paginated,
  RequiredMarks,
  SigningSession,
  SubmitRegionsInput,
  ZoneType,
} from '@scansign/shared';
import { api, fileFromUri } from './api';

/**
 * The folder list.
 *
 * No polling interval on purpose. The live socket pushes an update the instant
 * the console sends a document, so a timer would only add a periodic refetch
 * the signer can see for no benefit. Pull-to-refresh stays for the rare case
 * where the socket is down.
 */
export const useMyFolders = (deviceId: string | null) =>
  useQuery({
    queryKey: ['folders', deviceId],
    queryFn: () => api<Paginated<Folder>>(`/folders?deviceId=${deviceId}`),
    enabled: Boolean(deviceId),
    refetchOnWindowFocus: false,
    // Keep showing the current list while a background refetch runs, so an
    // update never blanks the screen or flashes a spinner.
    placeholderData: (previous) => previous,
  });

export const useFolder = (id: string | undefined) =>
  useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });

export const useAcknowledgeFolder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => api<Folder>(`/folders/${folderId}/ack`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['folder'] });
    },
  });
};

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
 * The document with its signature and stamp zones drawn on it, so the signer
 * can check the placement before committing to a photo.
 */
export const useDocumentPreview = (documentId: string | undefined) =>
  useQuery({
    queryKey: ['document-preview', documentId],
    queryFn: () => api<DocumentPreview>(`/documents/${documentId}/preview-url`),
    enabled: Boolean(documentId),
    // Signed URLs expire; refresh well before the server's 15 minute window.
    staleTime: 10 * 60 * 1000,
  });

export const useDocument = (documentId: string | undefined) =>
  useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api<Document>(`/documents/${documentId}`),
    enabled: Boolean(documentId),
  });

export interface CreatedSession {
  session: SigningSession;
  /** How many of each mark this folder's templates call for. */
  marks: RequiredMarks;
  /** Null in per-mark mode: each photo is uploaded separately afterwards. */
  photo: { url: string; width: number; height: number } | null;
  /** Where the backend thinks the ink is. Advisory: the user still confirms. */
  suggestions?: { signature: NormalizedRect | null; stamp: NormalizedRect | null } | null;
}

/** What this folder actually needs — decides how many capture steps there are. */
export const useRequiredMarks = (folderId: string | undefined) =>
  useQuery({
    queryKey: ['required-marks', folderId],
    queryFn: () => api<RequiredMarks>(`/folders/${folderId}/required-marks`),
    enabled: Boolean(folderId),
  });

/**
 * Start a session.
 * In `single` mode the sheet is uploaded here; in `per_mark` mode the session
 * opens empty and each mark is photographed in turn.
 */
export const useStartSession = () =>
  useMutation({
    mutationFn: ({
      folderId,
      captureMode,
      uri,
    }: {
      folderId: string;
      captureMode: CaptureMode;
      uri?: string;
    }) => {
      const form = new FormData();
      if (uri) form.append('photo', fileFromUri(uri, 'capture.jpg', 'image/jpeg'));
      return api<CreatedSession>(
        `/folders/${folderId}/signing-sessions?captureMode=${captureMode}`,
        { method: 'POST', form },
      );
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
    mutationFn: ({ sessionId, mark, uri }: { sessionId: string; mark: ZoneType; uri: string }) => {
      const form = new FormData();
      form.append('photo', fileFromUri(uri, `${mark}.jpg`, 'image/jpeg'));
      return api<MarkPhotoResult>(`/signing-sessions/${sessionId}/photo/${mark}`, {
        method: 'POST',
        form,
      });
    },
  });

/**
 * Ask what the extraction engine will make of a region before committing.
 * Background removal is the step most likely to disappoint, and the photo alone
 * gives the signer no way to judge it.
 */
export const usePreviewCutout = () =>
  useMutation({
    mutationFn: ({
      sessionId,
      mark,
      region,
    }: {
      sessionId: string;
      mark: ZoneType;
      region: NormalizedRect;
    }) =>
      api<CutoutPreview>(`/signing-sessions/${sessionId}/preview-cutout`, {
        method: 'POST',
        json: { mark, region },
      }),
  });

export interface SessionDocument {
  id: string;
  filename: string;
  pageCount: number;
  status: string;
}

/** The documents in this session's folder — one variant goes to each. */
export const useSessionDocuments = (sessionId: string | null) =>
  useQuery({
    queryKey: ['session-documents', sessionId],
    queryFn: () => api<Paginated<SessionDocument>>(`/signing-sessions/${sessionId}/documents`),
    enabled: Boolean(sessionId),
    staleTime: 60_000,
  });

/** One variant per document, so a folder of four contracts is signed four times. */
export const useGenerateVariants = () =>
  useMutation({
    mutationFn: ({
      sessionId,
      mark,
      region,
      count,
    }: {
      sessionId: string;
      mark: ZoneType;
      region: NormalizedRect;
      count: number;
    }) =>
      api<{ mark: ZoneType; variants: GeneratedVariant[] }>(
        `/signing-sessions/${sessionId}/preview-variants`,
        { method: 'POST', json: { mark, region, count } },
      ),
  });

export type { MarkAssignments };

export const useSubmitRegions = () =>
  useMutation({
    mutationFn: ({ sessionId, regions }: { sessionId: string; regions: SubmitRegionsInput }) =>
      api<SigningSession>(`/signing-sessions/${sessionId}/regions`, {
        method: 'POST',
        json: regions,
      }),
  });

export const useSession = (sessionId: string | undefined, poll: boolean) =>
  useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api<SigningSession>(`/signing-sessions/${sessionId}`),
    enabled: Boolean(sessionId),
    refetchInterval: poll ? 1500 : false,
  });
