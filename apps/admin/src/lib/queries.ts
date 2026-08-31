import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DashboardStats,
  Device,
  Document,
  Folder,
  Paginated,
  SaveTemplateInput,
  Template,
} from '@scansign/shared';
import { api } from './api';

/**
 * Statuses move on the server (a phone signs, a job finishes), so lists poll.
 * 4s is fast enough to feel live without hammering the API.
 */
const LIVE = { refetchInterval: 4000 } as const;

export const useDashboard = () =>
  useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardStats>('/dashboard'), ...LIVE });

export const useActivity = () =>
  useQuery({
    queryKey: ['activity'],
    queryFn: () =>
      api<Paginated<{ id: string; action: string; created_at: string; metadata: Record<string, unknown> }>>(
        '/dashboard/activity',
      ),
    ...LIVE,
  });

export const useDevices = () =>
  useQuery({ queryKey: ['devices'], queryFn: () => api<Paginated<Device>>('/devices'), ...LIVE });

export const useFolders = () =>
  useQuery({ queryKey: ['folders'], queryFn: () => api<Paginated<Folder>>('/folders'), ...LIVE });

export const useFolder = (id: string | undefined) =>
  useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
    enabled: Boolean(id),
    ...LIVE,
  });

export const useTemplates = () =>
  useQuery({ queryKey: ['templates'], queryFn: () => api<Paginated<Template>>('/templates') });

export const useTemplate = (id: string | undefined) =>
  useQuery({
    queryKey: ['template', id],
    queryFn: () => api<Template>(`/templates/${id}`),
    enabled: Boolean(id) && id !== 'new',
  });

export const useInvalidate = () => {
  const qc = useQueryClient();
  return (...keys: string[]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
  };
};

export const useCreateFolder = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { name: string; deviceId?: string | null }) =>
      api<Folder>('/folders', { method: 'POST', json: input }),
    onSuccess: () => invalidate('folders', 'dashboard'),
  });
};

export const useUploadDocuments = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ folderId, files }: { folderId: string; files: File[] }) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      return api<Folder>(`/folders/${folderId}/documents`, { method: 'POST', form });
    },
    onSuccess: () => invalidate('folder', 'folders', 'dashboard'),
  });
};

export const useSendFolder = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ folderId, deviceId }: { folderId: string; deviceId: string }) =>
      api<Folder>(`/folders/${folderId}/send`, { method: 'POST', json: { deviceId } }),
    onSuccess: () => invalidate('folder', 'folders', 'dashboard'),
  });
};

export const useDeleteFolder = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (folderId: string) => api<{ ok: true }>(`/folders/${folderId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('folders', 'dashboard'),
  });
};

export const useAssignTemplate = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ documentId, templateId }: { documentId: string; templateId: string }) =>
      api<Document>(`/documents/${documentId}/template`, {
        method: 'POST',
        json: { templateId },
      }),
    onSuccess: () => invalidate('folder', 'folders', 'templates', 'dashboard'),
  });
};

export const useSaveTemplate = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: SaveTemplateInput }) =>
      id
        ? api<Template>(`/templates/${id}`, { method: 'PUT', json: input })
        : api<Template>('/templates', { method: 'POST', json: input }),
    onSuccess: () => invalidate('templates', 'template', 'folders', 'folder'),
  });
};

export const useDeleteTemplate = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('templates'),
  });
};

export const useRenameDevice = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<Device>(`/devices/${id}`, { method: 'PATCH', json: { name } }),
    onSuccess: () => invalidate('devices'),
  });
};

export const useDeleteDevice = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('devices', 'dashboard'),
  });
};

/** Fetch a short-lived signed URL and hand the file to the browser. */
export const downloadFinalPdf = async (documentId: string): Promise<void> => {
  const { url, filename } = await api<{ url: string; filename: string }>(
    `/documents/${documentId}/final-url`,
  );
  const blob = await (await fetch(url)).blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  window.document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
};

export const fetchOriginalUrl = (documentId: string) =>
  api<{ url: string; filename: string }>(`/documents/${documentId}/original-url`);
