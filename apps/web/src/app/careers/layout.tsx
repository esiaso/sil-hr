import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '@sil/hr-shared';
import { BrandMark } from '@/components/brand';

export const metadata = { title: { default: 'Careers', template: '%s · Careers' } };

/** The public careers site: no sign-in, nothing loaded from other hosts. */
export default function CareersLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)]">
      <header className="border-b border-[var(--border)] bg-[var(--bg)]">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <Link href="/careers" className="font-display flex items-center gap-2 font-semibold" style={{ color: 'var(--title)' }}>
            <BrandMark size={26} />
            Careers
          </Link>
          <Link href="/login" className="muted text-sm hover:underline">Staff sign-in</Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      <footer className="mx-auto max-w-4xl px-4 pb-8 text-xs"><span className="muted">Recruitment by <span className="font-display font-semibold" style={{ color: 'var(--title)' }}>People<span style={{ color: 'var(--highlight-text)' }}>Track</span></span> · {BRAND.endorsement}</span></footer>
    </div>
  );
}
