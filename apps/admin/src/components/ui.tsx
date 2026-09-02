import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import {
  DOCUMENT_STATUS_LABEL,
  ERROR_CODE_LABEL,
  FOLDER_STATUS_LABEL,
  type DocumentStatus,
  type ErrorCode,
  type FolderStatus,
} from '@scansign/shared';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-500 disabled:bg-ink-200 disabled:text-ink-400',
  secondary:
    'bg-white text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50 disabled:text-ink-400 disabled:hover:bg-white',
  ghost: 'text-ink-600 hover:bg-ink-100 disabled:text-ink-400',
  danger: 'bg-white text-red-600 ring-1 ring-red-200 hover:bg-red-50',
};

export const Button = ({
  variant = 'primary',
  className = '',
  loading = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) => (
  <button
    {...props}
    disabled={props.disabled || loading}
    className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
  >
    {loading && (
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
    )}
    {children}
  </button>
);

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-xl bg-white ring-1 ring-ink-200/70 ${className}`}>{children}</div>
);

export const Field = ({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-ink-800">{label}</span>
    <input
      {...props}
      className="w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-ink-200 outline-none focus:ring-2 focus:ring-brand-500"
    />
    {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
  </label>
);

export const Select = ({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) => (
  <label className="block">
    {label && <span className="mb-1.5 block text-sm font-medium text-ink-800">{label}</span>}
    <select
      {...props}
      className="w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-ink-200 outline-none focus:ring-2 focus:ring-brand-500"
    >
      {children}
    </select>
  </label>
);

const FOLDER_TONE: Record<FolderStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  delivered: 'bg-sky-50 text-sky-700 ring-sky-200',
  in_progress: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  processing: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
};

const DOCUMENT_TONE: Record<DocumentStatus, string> = {
  awaiting_template: 'bg-amber-50 text-amber-700 ring-amber-200',
  ready: 'bg-sky-50 text-sky-700 ring-sky-200',
  processing: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
};

const pill = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1';

export const FolderStatusPill = ({ status }: { status: FolderStatus }) => (
  <span className={`${pill} ${FOLDER_TONE[status]}`}>{FOLDER_STATUS_LABEL[status]}</span>
);

export const DocumentStatusPill = ({ status }: { status: DocumentStatus }) => (
  <span className={`${pill} ${DOCUMENT_TONE[status]}`}>{DOCUMENT_STATUS_LABEL[status]}</span>
);

/** Turns a machine code into the sentence the operator actually needs. */
export const ErrorNote = ({ code, message }: { code?: string | null; message?: string | null }) => {
  if (!code && !message) return null;
  const label = code && code in ERROR_CODE_LABEL ? ERROR_CODE_LABEL[code as ErrorCode] : null;
  return (
    <p className="mt-1 text-xs text-red-600">
      {label ?? message}
      {label && message && label !== message ? ` — ${message}` : ''}
    </p>
  );
};

const SPIN = 'inline-block animate-spin rounded-full border-2 border-ink-200 border-t-brand-600';

/**
 * Two shapes from one component.
 *
 * Bare, it is a page-level spinner: centred, with the vertical breathing room a
 * loading screen wants. Given a `className` it is an inline one — sized by the
 * caller and with no padding of its own, because a `py-12` wrapper inside a
 * 46px button is what turns a neat spinner into a broken layout.
 */
export const Spinner = ({ className }: { className?: string } = {}) =>
  className ? (
    <span className={`${SPIN} ${className}`} />
  ) : (
    <div className="flex justify-center py-12">
      <span className={`${SPIN} h-6 w-6`} />
    </div>
  );

export const EmptyState = ({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) => (
  <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
    <p className="text-sm font-medium text-ink-800">{title}</p>
    <p className="max-w-sm text-sm text-ink-400">{description}</p>
    {action && <div className="mt-3">{action}</div>}
  </div>
);

export const Modal = ({
  open,
  title,
  onClose,
  children,
  /**
   * 'wide' gives the dialog the room a document needs: a form reads better
   * narrow, but a PDF at 400px is unreadable, which defeats the point of
   * looking at it.
   */
  size = 'default',
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'default' | 'wide';
  /** Rendered in the header, next to the close button. */
  actions?: ReactNode;
}) => {
  if (!open) return null;
  const wide = size === 'wide';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
      <div
        className={`flex w-full flex-col rounded-xl bg-white p-5 shadow-xl ${
          wide ? 'max-h-[92vh] max-w-5xl' : 'max-w-md'
        }`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <div className="flex items-center gap-2">
            {actions}
            <button onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-ink-100" aria-label="Fermer">
              ✕
            </button>
          </div>
        </div>
        <div className={wide ? 'min-h-0 flex-1 overflow-y-auto' : undefined}>{children}</div>
      </div>
    </div>
  );
};

export const formatDate = (value: string | null): string =>
  value
    ? new Date(value).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** "à l’instant", "il y a 20 min", "il y a 3 h", "hier", then the date. */
export const timeAgo = (value: string | null | undefined, now = Date.now()): string => {
  if (!value) return '—';
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 45) return 'à l’instant';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} jours`;
  return new Date(value).toLocaleDateString('fr-FR');
};

export const folderReference = (reference: number): string =>
  `#${String(reference).padStart(6, '0')}`;
