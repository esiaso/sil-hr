'use client';

import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError } from '@/lib/api';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60',
  secondary: 'surface hover:brightness-95 disabled:opacity-60',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-60',
  ghost: 'hover:bg-black/5 dark:hover:bg-white/10',
};

export function Button({ variant = 'primary', busy, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} className={cx('inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition', VARIANTS[variant], className)}>
      {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="muted text-xs">{hint}</p>}
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('input', props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx('input', props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx('input min-h-20', props.className)} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="muted mt-1 max-w-3xl text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('surface rounded-lg p-4', className)}>{children}</div>;
}

const BADGE: Record<string, string> = {
  valid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  verified: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  probation: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  onboarding: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  queued: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  on_notice: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  expiring: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  not_verified: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  missing: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  suspended: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  expired: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  exited: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  success: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  inactive: 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  disabled: 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  retrying: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  pending: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  locked: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  dead_lettered: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export function Badge({ value }: { value: string }) {
  return <span className={cx('inline-block rounded px-2 py-0.5 text-xs font-medium', BADGE[value] ?? BADGE[value.split(' ').pop() ?? ''] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300')}>{value.replace(/_/g, ' ')}</span>;
}

export function ProblemBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  const id = error instanceof ApiError ? (error.problem.correlation_id as string | undefined) : undefined;
  return (
    <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
      {msg}
      {id && <span className="ml-2 opacity-70">(ref {id.slice(0, 8)})</span>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted py-10 text-center text-sm">{children}</div>;
}

export function Loading() {
  return <div className="muted py-10 text-center text-sm">Loading…</div>;
}

/** Modal dialog: Esc and the backdrop close it; focus moves into it on open. */
export function Dialog({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Focus the first form control (not the close button), falling back to any button.
    (ref.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea') ?? ref.current?.querySelector<HTMLElement>('button'))?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('surface w-full rounded-lg p-5 shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <button onClick={onClose} aria-label="Close" className="muted rounded px-2 text-xl leading-none hover:bg-black/5">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Shown once after creating a secret: copy it now, it is never shown again. */
export function SecretReveal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
      <p className="mb-2 font-medium">{label}: copy it now. It will not be shown again.</p>
      <div className="flex gap-2">
        <code className="block flex-1 overflow-x-auto rounded bg-white px-2 py-1 font-mono text-xs dark:bg-black/40">{value}</code>
        <Button variant="secondary" type="button" onClick={() => navigator.clipboard.writeText(value)}>
          Copy
        </Button>
      </div>
    </div>
  );
}

export function LoadMore({ hasMore, onClick, busy }: { hasMore: boolean; onClick: () => void; busy?: boolean }) {
  if (!hasMore) return null;
  return (
    <div className="mt-3 text-center">
      <Button variant="secondary" onClick={onClick} busy={busy}>
        Load more
      </Button>
    </div>
  );
}
