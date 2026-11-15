'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { authPost, hr, unwrap } from '@/lib/api';
import { visibleNav } from '@/lib/nav';
import { SessionProvider, useSession } from '@/lib/session';
import { cx } from './ui';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider fallback={<div className="muted p-10 text-center text-sm">Loading…</div>}>
      <Frame>{children}</Frame>
    </SessionProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { me, settings } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const groups = visibleNav(me.permissions);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (me.must_change_password && pathname !== '/account') router.replace('/account?change=1');
  }, [me.must_change_password, pathname, router]);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => unwrap(hr.GET('/api/v1/notifications')),
    refetchInterval: 60_000,
  });
  const unread = (notifications.data ?? []).filter((n) => !n.read_at).length;

  // '/' and '/organisation' are parents of other entries, so they match exactly.
  const isActive = (href: string) => (href === '/' || href === '/organisation' || href === '/people' || href === '/leave' || href === '/attendance' ? pathname === href || (href === '/people' && /^\/people\/[0-9a-f-]{36}/.test(pathname)) : pathname === href || pathname.startsWith(`${href}/`));
  const nav = (
    <nav aria-label="Main" className="space-y-5 p-3 text-sm">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="muted mb-1 px-2 text-xs font-semibold tracking-wide uppercase">{g.label}</div>
          <ul>
            {g.items.map((i) => (
              <li key={i.href}>
                <Link href={i.href} aria-current={isActive(i.href) ? 'page' : undefined} className={cx('block rounded-md px-2 py-1.5', isActive(i.href) ? 'bg-brand-50 font-medium text-brand-700 dark:bg-white/10 dark:text-white' : 'hover:bg-black/5 dark:hover:bg-white/5')}>
                  {i.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Skip to content
      </a>
      <aside className="surface hidden w-60 shrink-0 border-y-0 border-l-0 lg:block">
        <div className="px-5 py-4 text-base font-semibold">
          <span className="text-brand-600">SIL</span> HR
          <div className="muted truncate text-xs font-normal">{settings.organisation_name}</div>
        </div>
        {nav}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="surface h-full w-72 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 font-semibold">SIL HR</div>
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="surface flex items-center gap-3 border-x-0 border-t-0 px-4 py-2">
          <button className="rounded p-2 lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}>
            ☰
          </button>
          <div className="flex-1" />
          <Link href="/notifications" className="relative rounded px-2 py-1 text-sm hover:bg-black/5" aria-label={`Notifications, ${unread} unread`}>
            🔔{unread > 0 && <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">{unread}</span>}
          </Link>
          <Link href="/account" className="text-sm hover:underline">
            {me.display_name}
          </Link>
          <button
            className="muted rounded px-2 py-1 text-sm hover:bg-black/5"
            onClick={async () => {
              await authPost('/auth/logout');
              window.location.href = '/login';
            }}
          >
            Sign out
          </button>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
