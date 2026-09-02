/**
 * A CSV reader for a CRM export: quotes, embedded separators and newlines,
 * `;` or `,` or tab as delimiter (detected on the header), UTF-8 with or
 * without BOM, Latin-1 as a fallback. Returns one object per row keyed by the
 * header, headers lower-cased and trimmed so the lead mapper's aliases apply.
 */
export const parseCsv = (bytes: Uint8Array): Record<string, unknown>[] => {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // A Latin-1 export shows up as replacement characters; decode it as such.
  if (/�/.test(text)) text = new TextDecoder('latin1').decode(bytes);
  text = text.replace(/^﻿/, '');

  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', ',', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/^﻿/, ''));
  return body.map((cells) => {
    const o: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      if (k) o[k] = (cells[i] ?? '').trim();
    });
    return o;
  });
};
