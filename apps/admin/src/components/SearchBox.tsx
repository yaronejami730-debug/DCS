import type { InputHTMLAttributes } from 'react';

/** The search field: one line, a magnifier, a clear button when it holds text. */
export const SearchBox = ({
  value,
  onChange,
  placeholder = 'Rechercher un client, un dossier, un document…',
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (value: string) => void;
}) => (
  <div className={`relative ${className}`}>
    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400">⌕</span>
    <input
      {...props}
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg bg-white py-2 pl-9 pr-9 text-sm ring-1 ring-ink-200 outline-none placeholder:text-ink-400 focus:ring-2 focus:ring-brand-500"
    />
    {value && (
      <button
        type="button"
        onClick={() => onChange('')}
        aria-label="Effacer la recherche"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-ink-400 hover:text-ink-700"
      >
        ×
      </button>
    )}
  </div>
);
