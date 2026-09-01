import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import {
  DOCUMENT_STATUS_LABEL,
  FOLDER_STATUS_LABEL,
  type DocumentStatus,
  type FolderStatus,
} from '@scansign/shared';

/**
 * The signer's UI kit — the browser counterpart of the iPhone app's ui.tsx.
 *
 * Sized for a thumb, not a mouse: controls are 52px tall, the same as on the
 * phone, because every screen here is used one-handed while holding a sheet of
 * paper in the other. The console's own kit is deliberately not reused; it is
 * built for a desk, with 32px rows.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-white active:bg-brand-600 disabled:bg-ink-200 disabled:text-ink-400',
  secondary:
    'bg-white text-ink-900 ring-1 ring-ink-200 active:bg-ink-50 disabled:text-ink-400 disabled:ring-ink-100',
  ghost: 'bg-transparent text-ink-600 active:bg-ink-100 disabled:text-ink-400',
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
    className={`inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold transition disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
  >
    {loading && (
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
    )}
    {children}
  </button>
);

/**
 * The page frame.
 *
 * `min-h-dvh`, not `min-h-screen`: on iOS Safari `100vh` is the height with the
 * address bar hidden, so a full-height screen sits under the toolbar and the
 * primary button ends up unreachable until you scroll.
 */
export const Screen = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`mx-auto flex min-h-dvh w-full max-w-[560px] flex-col ${className}`}>
    {children}
  </div>
);

export const Title = ({ children }: { children: ReactNode }) => (
  <h1 className="text-[26px] font-bold leading-tight tracking-tight text-ink-900">{children}</h1>
);

export const Subtitle = ({ children }: { children: ReactNode }) => (
  <p className="mt-1 text-[15px] leading-6 text-ink-400">{children}</p>
);

export const Card = ({
  children,
  className = '',
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) => {
  const base = `rounded-xl bg-white p-4 ring-1 ring-ink-200 ${className}`;
  if (!onClick) return <div className={base}>{children}</div>;
  return (
    <button type="button" onClick={onClick} className={`${base} w-full text-left active:bg-ink-50`}>
      {children}
    </button>
  );
};

export const Field = ({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-semibold text-ink-900">{label}</span>
    <input
      {...props}
      // 16px minimum: anything smaller makes iOS Safari zoom the page on focus,
      // and it never zooms back out.
      className="h-[50px] w-full rounded-xl bg-white px-3.5 text-base text-ink-900 ring-1 ring-ink-200 outline-none focus:ring-2 focus:ring-brand-500"
    />
    {hint && <span className="mt-2 block text-[13px] text-ink-400">{hint}</span>}
  </label>
);

const TONE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700',
  delivered: 'bg-brand-50 text-brand-600',
  in_progress: 'bg-brand-50 text-brand-600',
  processing: 'bg-brand-50 text-brand-600',
  completed: 'bg-emerald-50 text-emerald-700',
  error: 'bg-red-50 text-red-700',
  awaiting_template: 'bg-amber-50 text-amber-700',
  ready: 'bg-brand-50 text-brand-600',
};

export const Pill = ({ label, tone }: { label: string; tone: string }) => (
  <span
    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
      TONE[tone] ?? 'bg-ink-100 text-ink-400'
    }`}
  >
    {label}
  </span>
);

export const FolderPill = ({ status }: { status: FolderStatus }) => (
  <Pill label={FOLDER_STATUS_LABEL[status]} tone={status} />
);

export const DocumentPill = ({ status }: { status: DocumentStatus }) => (
  <Pill label={DOCUMENT_STATUS_LABEL[status]} tone={status} />
);

export const Spinner = ({ className = '' }: { className?: string }) => (
  <span
    className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent ${className}`}
  />
);

export const Loading = ({ label }: { label?: string }) => (
  <div className="flex min-h-dvh flex-col items-center justify-center gap-3">
    <Spinner />
    {label && <p className="text-[15px] text-ink-400">{label}</p>}
  </div>
);

export const ErrorBanner = ({ message }: { message: string }) => (
  <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{message}</div>
);

export const BackLink = ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    // A 44px target: the label alone is 20px tall and gets missed constantly.
    className="-ml-2 inline-flex h-11 items-center px-2 text-base font-semibold text-brand-500 active:text-brand-600"
  >
    ‹ {children}
  </button>
);

/** Progress through a multi-mark capture, as on the phone. */
export const Steps = ({ count, index }: { count: number; index: number }) => (
  <div className="mb-2.5 flex items-center gap-1.5">
    {Array.from({ length: count }, (_, i) => (
      <span
        key={i}
        className={`h-1 w-[22px] rounded-full ${i <= index ? 'bg-brand-500' : 'bg-ink-200'}`}
      />
    ))}
    <span className="ml-1.5 text-[12.5px] font-semibold text-ink-400">
      Étape {index + 1} sur {count}
    </span>
  </div>
);
