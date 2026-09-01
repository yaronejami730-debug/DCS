import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CutoutPreview,
  DashboardStats,
  Document,
  DocumentRole,
  ExtractionEngine,
  DocumentPlacement,
  FolderComparison,
  Folder,
  NormalizedRect,
  Paginated,
  RequiredMarks,
  SaveTemplateInput,
  ShareLink,
  ShareLinkReturn,
  ShareScope,
  SigningSession,
  SubmitRegionsInput,
  Template,
  ZoneType,
} from '@scansign/shared';
import { api, downloadFile } from './api';

/**
 * Statuses move on the server (a signer submits, a job finishes), so lists
 * poll. 4s is fast enough to feel live without hammering the API.
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

export interface NotificationRow {
  id: string;
  title: string;
  body: string;
  status: string;
  error: string | null;
  created_at: string;
  folder_id: string | null;
}

/** What the system told this account, and whether it got through. */
export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<Paginated<NotificationRow>>('/dashboard/notifications'),
    ...LIVE,
  });


export const useFolders = () =>
  useQuery({ queryKey: ['folders'], queryFn: () => api<Paginated<Folder>>('/folders'), ...LIVE });

export const useFolder = (id: string | undefined) =>
  useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
    enabled: Boolean(id),
    ...LIVE,
  });

/**
 * The library: reusable templates only. `includeOneOff` also returns the ones
 * configured for a single document, so they stay reachable — the editor can
 * promote one back by ticking "Réutilisable".
 */
export const useTemplates = (includeOneOff = false) =>
  useQuery({
    queryKey: ['templates', includeOneOff],
    queryFn: () =>
      api<Paginated<Template>>(`/templates${includeOneOff ? '?all=true' : ''}`),
  });

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
    mutationFn: (input: { name: string }) =>
      api<Folder>('/folders', { method: 'POST', json: input }),
    onSuccess: () => invalidate('folders', 'dashboard'),
  });
};

export const useUploadDocuments = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      folderId,
      files,
      role = 'to_sign',
    }: {
      folderId: string;
      files: File[];
      /** Contract or capture sheet. See DOCUMENT_ROLE. */
      role?: DocumentRole;
    }) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      form.append('role', role);
      return api<Folder>(`/folders/${folderId}/documents`, { method: 'POST', form });
    },
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

/**
 * Share links — how a folder reaches a signer now.
 *
 * Every link ever minted is listed, revoked ones included: an operator asking
 * "why can't the technician open it any more" needs to see that a link existed
 * and was cut off, not an empty list.
 */
export const useShareLinks = (folderId: string | undefined) =>
  useQuery({
    queryKey: ['share-links', folderId],
    queryFn: () => api<Paginated<ShareLink>>(`/folders/${folderId}/share-links`),
    enabled: Boolean(folderId),
    // Presence lives here: the green dot has to move while the operator
    // watches, and 4s is the cadence the rest of the console already uses.
    refetchInterval: 4000,
  });

export const useCreateShareLink = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      folderId,
      label,
      expiresInDays,
      scope = 'signer',
      documentIds,
      requireLocation = false,
    }: {
      folderId: string;
      label?: string | null;
      expiresInDays?: number | null;
      /** 'operator' is the self-handoff to a phone; it sees the documents. */
      scope?: ShareScope;
      /** Empty or omitted covers the whole folder, now and later. */
      documentIds?: string[];
      /** Ask the technician for their location on return. */
      requireLocation?: boolean;
    }) =>
      api<ShareLink>(`/folders/${folderId}/share-links`, {
        method: 'POST',
        json: { label: label ?? null, expiresInDays, scope, documentIds, requireLocation },
      }),
    onSuccess: () => invalidate('share-links', 'folder', 'folders', 'dashboard'),
  });
};

/** Change which documents a link covers, keeping the URL the signer already has. */
export const useSetShareLinkDocuments = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      folderId,
      linkId,
      documentIds,
    }: {
      folderId: string;
      linkId: string;
      documentIds: string[];
    }) =>
      api<ShareLink>(`/folders/${folderId}/share-links/${linkId}/documents`, {
        method: 'PUT',
        json: { documentIds },
      }),
    onSuccess: () => invalidate('share-links'),
  });
};

export const useRevokeShareLink = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ folderId, linkId }: { folderId: string; linkId: string }) =>
      api<ShareLink>(`/folders/${folderId}/share-links/${linkId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('share-links', 'folder', 'folders', 'dashboard'),
  });
};

/** Fetch a short-lived signed URL and hand the file to the browser. */
/**
 * Address of the signed PDF, without downloading it.
 *
 * Split out of downloadFinalPdf so the on-screen viewer can open the same file
 * the download would produce — an operator checking the stamp before sending
 * the document out should not have to save it first.
 */
export const finalPdfUrl = (documentId: string) =>
  api<{ url: string; filename: string }>(`/documents/${documentId}/final-url`);

export const downloadFinalPdf = async (documentId: string): Promise<void> => {
  const { url, filename } = await finalPdfUrl(documentId);
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

/** Download the template as a PDF with its zones drawn on the document. */
export const downloadTemplatePdf = (templateId: string) =>
  downloadFile(`/templates/${templateId}/export`, 'template.pdf');

/** Create a template from a name and a PDF, with no folder involved. */
export const useCreateTemplateFromPdf = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) => {
      const form = new FormData();
      form.append('name', name);
      form.append('file', file);
      return api<Template>('/templates/upload', { method: 'POST', form });
    },
    onSuccess: () => invalidate('templates'),
  });
};

/** The PDF a template was configured against — what the editor draws on. */
export const fetchTemplateSource = (templateId: string) =>
  api<{ url: string; filename: string; pageCount: number | null }>(
    `/templates/${templateId}/source-url`,
  );

export const fetchOriginalUrl = (documentId: string) =>
  api<{ url: string; filename: string }>(`/documents/${documentId}/original-url`);

// --- placement on a signed document ---------------------------------------

export const useDocument = (id: string | undefined) =>
  useQuery({
    queryKey: ['document', id],
    queryFn: () => api<Document>(`/documents/${id}`),
    enabled: Boolean(id),
  });

/** Where a document's marks sit, and whether it may be repositioned at all. */
export const useDocumentPlacement = (id: string | undefined) =>
  useQuery({
    queryKey: ['placement', id],
    queryFn: () => api<DocumentPlacement>(`/documents/${id}/placement`),
    enabled: Boolean(id),
  });

/**
 * A short-lived link to the SIGNED PDF, for the editor to draw on.
 *
 * Not cached for long: the URL expires, and it changes every time the document
 * is regenerated, so a stale one would show the operator the version they just
 * replaced.
 */
export const useSignedPdfUrl = (id: string | undefined) =>
  useQuery({
    queryKey: ['final-url', id],
    queryFn: () => api<{ url: string; filename: string }>(`/documents/${id}/final-url`),
    enabled: Boolean(id),
    staleTime: 0,
    gcTime: 0,
  });

export interface PlacementZoneInput {
  page: number;
  type: ZoneType;
  rect: NormalizedRect;
  index: number;
}

/** Re-stamp a signed document with new geometry, same signature. */
export const useAdjustPlacement = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      documentId,
      zones,
    }: {
      documentId: string;
      zones: PlacementZoneInput[];
    }) =>
      api<{ documentId: string; placed: number; bytes: number }>(
        `/documents/${documentId}/placement`,
        { method: 'POST', json: { zones } },
      ),
    // 'final-url' too: the PDF behind that link has just been rewritten, and a
    // cached URL would render the previous version in the editor.
    onSuccess: () => invalidate('placement', 'document', 'final-url', 'folder', 'folders'),
  });
};

/** Drop the document's own placement and follow its template again. */
export const useResetPlacement = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (documentId: string) =>
      api<{ documentId: string; placed: number }>(`/documents/${documentId}/placement`, {
        method: 'DELETE',
      }),
    onSuccess: () => invalidate('placement', 'document', 'final-url', 'folder', 'folders'),
  });
};

/**
 * The folder's signatures, for the comparison screen.
 *
 * Not on LIVE polling: the signed URLs it hands out are short-lived, and
 * refetching every 4s would swap them under a canvas mid-render for a screen
 * whose content only changes when a document is re-signed.
 */
export const useFolderComparison = (id: string | undefined) =>
  useQuery({
    queryKey: ['comparison', id],
    queryFn: () => api<FolderComparison>(`/folders/${id}/comparison`),
    enabled: Boolean(id),
  });

// --- returned scans -------------------------------------------------------

/**
 * The signed pages technicians have sent back for this folder.
 *
 * Polled with the rest: a scan arriving is the event the operator is waiting
 * for, and the live socket already invalidates this on `folder.updated`.
 */
export const useReturns = (folderId: string | undefined) =>
  useQuery({
    queryKey: ['returns', folderId],
    queryFn: () => api<Paginated<ShareLinkReturn>>(`/folders/${folderId}/returns`),
    enabled: Boolean(folderId),
    ...LIVE,
  });

export const useMarkReturnHandled = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ folderId, returnId }: { folderId: string; returnId: string }) =>
      api<ShareLinkReturn>(`/folders/${folderId}/returns/${returnId}/handled`, { method: 'POST' }),
    onSuccess: () => invalidate('returns'),
  });
};

export const useDeleteReturn = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ folderId, returnId }: { folderId: string; returnId: string }) =>
      api<{ ok: true }>(`/folders/${folderId}/returns/${returnId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('returns'),
  });
};

// --- cropping a returned scan --------------------------------------------

export interface CreatedSession {
  session: SigningSession;
  marks: RequiredMarks;
  photo: { url: string; width: number; height: number } | null;
  suggestions?: { signature: NormalizedRect | null; stamp: NormalizedRect | null } | null;
}

/**
 * Open a cropping session on a page of a returned scan.
 *
 * The page is rasterised in the browser — a scan may be a multi-page PDF, and
 * the extraction pipeline works on pixels — and uploaded as the session's
 * photo. Everything downstream is then the existing flow, unchanged: the same
 * cutout preview, the same variants, the same stamping.
 */
export const useStartCropSession = () =>
  useMutation({
    mutationFn: ({
      folderId,
      returnId,
      page,
    }: {
      folderId: string;
      returnId: string;
      /** The rasterised page, as a JPEG. */
      page: Blob;
    }) => {
      const form = new FormData();
      form.append('photo', page, 'scan.jpg');
      return api<CreatedSession>(
        `/folders/${folderId}/signing-sessions?captureMode=single&returnId=${returnId}`,
        { method: 'POST', form },
      );
    },
  });

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

export const useSubmitRegions = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ sessionId, regions }: { sessionId: string; regions: SubmitRegionsInput }) =>
      api<SigningSession>(`/signing-sessions/${sessionId}/regions`, {
        method: 'POST',
        json: regions,
      }),
    onSuccess: () => invalidate('folder', 'folders', 'returns', 'dashboard'),
  });
};

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

/**
 * Which marks this folder's templates actually call for.
 *
 * Drives the cropping screen's list, so the operator is offered the marks the
 * paperwork asks for rather than every type the system knows about.
 */
export const useRequiredMarks = (folderId: string | undefined) =>
  useQuery({
    queryKey: ['required-marks', folderId],
    queryFn: () => api<RequiredMarks>(`/folders/${folderId}/required-marks`),
    enabled: Boolean(folderId),
  });
