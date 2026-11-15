import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata = { title: { default: 'Careers', template: '%s · Careers' } };

/** The public careers site: no sign-in, nothing loaded from other hosts. */
export default function CareersLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)]">
      <header className="border-b border-[var(--border)] bg-[var(--bg)]">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <Link href="/careers" className="flex items-center gap-2 font-semibold" style={{ color: 'var(--title)' }}>
            <svg width="26" height="26" viewBox="0 0 28 28" aria-hidden><rect x="2" y="7" width="15" height="15" rx="4" fill="#3758f9" /><rect x="11" y="2" width="15" height="15" rx="4" fill="#8b9cff" fillOpacity="0.85" /></svg>
            Careers
          </Link>
          <Link href="/login" className="muted text-sm hover:underline">Staff sign-in</Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}
