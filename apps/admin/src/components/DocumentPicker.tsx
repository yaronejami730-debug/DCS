import type { Document } from '@scansign/shared';

/**
 * Which capture sheets a link sends.
 *
 * The empty selection is not "nothing" — it is "every sheet in this folder,
 * including ones added later". That is the useful default, and it is what the
 * backend stores, so the control has to say so rather than looking like an
 * unfinished form. An explicit "toutes les feuilles" row makes that state
 * selectable instead of something you fall into by unticking everything.
 */
export const DocumentPicker = ({
  documents,
  selected,
  onChange,
  disabled = false,
}: {
  documents: Document[];
  /** Empty means the whole folder. */
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) => {
  const all = selected.length === 0;

  const toggle = (id: string) => {
    if (all) {
      // Coming from "the whole folder", the first tick means "only this one",
      // not "all of them except this one" — which is what starting from the
      // full list would have meant.
      onChange([id]);
      return;
    }
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
    // Unticking the last one falls back to the whole folder rather than an
    // empty subset, which the backend cannot represent and which would mean a
    // link that signs nothing.
    onChange(next);
  };

  return (
    <div className="rounded-lg ring-1 ring-ink-200">
      <label
        className={`flex cursor-pointer items-center gap-2.5 border-b border-ink-200/70 px-3 py-2.5 ${
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-ink-50'
        }`}
      >
        <input
          type="radio"
          name="doc-scope"
          className="h-4 w-4 accent-brand-600"
          checked={all}
          disabled={disabled}
          onChange={() => onChange([])}
        />
        <span className="text-sm font-medium">Toutes les feuilles</span>
        <span className="ml-auto text-xs text-ink-400">
          {documents.length} feuille{documents.length > 1 ? 's' : ''} · et les suivantes
        </span>
      </label>

      <label
        className={`flex cursor-pointer items-center gap-2.5 px-3 py-2.5 ${
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-ink-50'
        }`}
      >
        <input
          type="radio"
          name="doc-scope"
          className="h-4 w-4 accent-brand-600"
          checked={!all}
          disabled={disabled || documents.length === 0}
          onChange={() => onChange(documents[0] ? [documents[0].id] : [])}
        />
        <span className="text-sm font-medium">Seulement certaines feuilles</span>
      </label>

      {!all && (
        <ul className="max-h-56 overflow-y-auto border-t border-ink-200/70 px-1.5 py-1.5">
          {documents.map((doc) => (
            <li key={doc.id}>
              <label
                className={`flex items-center gap-2.5 rounded px-2 py-1.5 ${
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-ink-50'
                }`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-ink-300 accent-brand-600"
                  checked={selected.includes(doc.id)}
                  disabled={disabled}
                  onChange={() => toggle(doc.id)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{doc.filename}</span>
                <span className="shrink-0 text-xs text-ink-400">{doc.pageCount} p.</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {!all && selected.length === 0 && (
        <p className="border-t border-ink-200/70 px-3 py-2 text-xs text-amber-700">
          Cochez au moins une feuille, sinon le lien les enverra toutes.
        </p>
      )}
    </div>
  );
};
