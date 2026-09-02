import { FOLDER_STATUS_LABEL, type Folder } from '@scansign/shared';

/**
 * One search box for folders: name, reference, status, the documents inside
 * and their templates. Accent- and case-insensitive, every word must match
 * somewhere ("dupont devis" finds the Dupont folder that holds a devis).
 * Built to take a CRM's records too, later: the same normaliser will apply.
 */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export const folderSearchText = (folder: Folder): string =>
  fold(
    [
      folder.name,
      `#${String(folder.reference).padStart(6, '0')}`,
      String(folder.reference),
      FOLDER_STATUS_LABEL[folder.status],
      ...(folder.documents ?? []).flatMap((d) => [d.filename, d.template?.name ?? '']),
    ].join(' '),
  );

export const matchesSearch = (folder: Folder, query: string): boolean => {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = folderSearchText(folder);
  return words.every((w) => haystack.includes(w));
};
