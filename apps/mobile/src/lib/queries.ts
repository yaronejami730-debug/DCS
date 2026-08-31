import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Document,
  Folder,
  Paginated,
  SigningSession,
  SubmitRegionsInput,
} from '@scansign/shared';
import { api, fileFromUri } from './api';

export const useMyFolders = (deviceId: string | null) =>
  useQuery({
    queryKey: ['folders', deviceId],
    queryFn: () => api<Paginated<Folder>>(`/folders?deviceId=${deviceId}`),
    enabled: Boolean(deviceId),
    refetchInterval: 15_000,
  });

export const useFolder = (id: string | undefined) =>
  useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
    enabled: Boolean(id),
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

export const useDocumentPreview = (documentId: string | undefined) =>
  useQuery({
    queryKey: ['document-preview', documentId],
    queryFn: () => api<{ url: string; filename: string }>(`/documents/${documentId}/original-url`),
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
  photo: { url: string; width: number; height: number };
}

export const useUploadPhoto = () =>
  useMutation({
    mutationFn: ({ folderId, uri }: { folderId: string; uri: string }) => {
      const form = new FormData();
      form.append('photo', fileFromUri(uri, 'capture.jpg', 'image/jpeg'));
      return api<CreatedSession>(`/folders/${folderId}/signing-sessions`, {
        method: 'POST',
        form,
      });
    },
  });

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
