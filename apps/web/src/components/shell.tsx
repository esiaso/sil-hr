'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Bell, BriefcaseBusiness, Building2, CalendarDays, CheckSquare, ChevronDown, Clock, Contact, FileText, LayoutDashboard, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen,
  HeartPulse, Plug, Search, Settings, ShieldCheck, Stethoscope, Sun, UserRound, Users, Wallet, X, type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authPost, hr, unwrap } from '@/lib/api';
import { visibleNav, type NavGroup } from '@/lib/nav';
import { SessionProvider, useSession } from '@/lib/session';
import { cx } from './ui';

const GROUP_ICONS: Record<string, LucideIcon> = {
  People: Users, Leave: CalendarDays, 'Time & attendance': Clock, Payroll: Wallet, 'Medical scheme': Stethoscope, Organisation: Building2, Administration: ShieldCheck, Integrations: Plug,
};
const HOME_ICONS: Record<string, LucideIcon> = {
  '/': LayoutDashboard, '/me': UserRound, '/leave': CalendarDays, '/attendance/me': Clock, '/me/payslips': FileText, '/medical': HeartPulse, '/approvals': CheckSquare, '/directory': Contact,
};

export function Shell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider fallback={<div className="muted p-10 text-center text-sm">Loading…</div>}>
      <Frame>{children}</Frame>
    </SessionProvider>
  );
}

/** The SIL HR mark: two overlapping rounded squares, drawn here so nothing is fetched. */
function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <rect x="2" y="7" width="15" height="15" rx="4" fill="#3758f9" />
        <rect x="11" y="2" width="15" height="15" rx="4" fill="#8b9cff" fillOpacity="0.85" />
      </svg>
      {!compact && <span className="text-lg font-semibold tracking-tight" style={{ color: 'var(--title)' }}>SIL <span className="font-normal">HR</span></span>}
    </span>
  );
}

function useTheme(): ['light' | 'dark', () => void] {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'), []);
  const toggle = useCallback(() => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('silhr-theme', next); } catch { /* private mode */ }
    setTheme(next);
  }, []);
  return [theme, toggle];
}

function isActiveFor(pathname: string) {
  // Parents of other entries match exactly (plus their detail pages).
  return (href: string) =>
    ['/', '/organisation', '/people', '/leave', '/attendance', '/me', '/payroll', '/medical'].includes(href)
      ? pathname === href || (href === '/people' && /^\/people\/[0-9a-f-]{36}/.test(pathname)) || (href === '/payroll' && pathname.startsWith('/payroll/runs/'))
      : pathname === href || pathname.startsWith(`${href}/`);
}

function Sidebar({ groups, isActive, collapsed }: { groups: NavGroup[]; isActive: (href: string) => boolean; collapsed: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { setOpen(JSON.parse(localStorage.getItem('silhr-nav') ?? '{}')); } catch { /* ignore */ }
  }, []);
  const toggle = (label: string, now: boolean) => {
    const next = { ...open, [label]: !now };
    setOpen(next);
    try { localStorage.setItem('silhr-nav', JSON.stringify(next)); } catch { /* ignore */ }
  };
  const [home, ...rest] = groups;
  const row = (active: boolean) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors', active ? 'bg-[var(--active)] font-medium text-[var(--title)]' : 'text-[var(--text)] hover:bg-[var(--hover)]');
  return (
    <nav aria-label="Main" className="space-y-1 px-3 pb-4 text-sm">
      {!collapsed && <div className="muted px-3 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">Main menu</div>}
      {home?.items.map((i) => {
        const Icon = HOME_ICONS[i.href] ?? LayoutDashboard;
        return (
          <Link key={i.href} href={i.href} title={collapsed ? i.label : undefined} aria-current={isActive(i.href) ? 'page' : undefined} className={row(isActive(i.href))}>
            <Icon size={18} strokeWidth={1.75} className="shrink-0" />{!collapsed && <span className="truncate">{i.label}</span>}
          </Link>
        );
      })}
      {!collapsed && rest.length > 0 && <div className="muted px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">Manage</div>}
      {rest.map((g) => {
        const Icon = GROUP_ICONS[g.label] ?? Settings;
        const hasActive = g.items.some((i) => isActive(i.href));
        const expanded = open[g.label] ?? hasActive;
        if (collapsed) {
          const first = g.items[0];
          return <Link key={g.label} href={first.href} title={g.label} className={row(hasActive)}><Icon size={18} strokeWidth={1.75} /></Link>;
        }
        return (
          <div key={g.label}>
            <button type="button" aria-expanded={expanded} onClick={() => toggle(g.label, expanded)} className={cx(row(false), 'w-full', hasActive && 'font-medium text-[var(--title)]')}>
              <Icon size={18} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1 truncate text-left">{g.label}</span>
              <ChevronDown size={16} className={cx('muted transition-transform', expanded && 'rotate-180')} />
            </button>
            {expanded && (
              <ul className="mt-0.5 mb-1 ml-[1.15rem] space-y-0.5 border-l border-[var(--border)] pl-3">
                {g.items.map((i) => (
                  <li key={i.href}>
                    <Link href={i.href} aria-current={isActive(i.href) ? 'page' : undefined} className={cx('block rounded-lg px-3 py-1.5 transition-colors', isActive(i.href) ? 'bg-[var(--active)] font-medium text-[var(--title)]' : 'muted hover:bg-[var(--hover)] hover:text-[var(--text)]')}>
                      {i.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** ⌘K / Ctrl K: jump to any page the user can open. */
function CommandPalette({ groups, onClose }: { groups: NavGroup[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = useMemo(() => groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))).filter((i) => !q || `${i.label} ${i.group}`.toLowerCase().includes(q.toLowerCase())), [groups, q]);
  const go = (href: string) => { onClose(); router.push(href); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-label="Go to a page" className="surface w-full max-w-lg overflow-hidden rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4">
          <Search size={18} className="muted" />
          <input
            ref={input} value={q} placeholder="Search pages…" aria-label="Search pages"
            className="w-full bg-transparent py-3 text-sm outline-none"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === 'Enter' && items[sel]) go(items[sel].href);
            }}
          />
        </div>
        <ul className="scroll-thin max-h-80 overflow-y-auto p-2 text-sm">
          {!items.length && <li className="muted px-3 py-6 text-center">No page matches.</li>}
          {items.map((i, n) => (
            <li key={i.href}>
              <button type="button" onMouseEnter={() => setSel(n)} onClick={() => go(i.href)} className={cx('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left', n === sel && 'bg-[var(--hover)]')}>
                <span>{i.label}</span><span className="muted text-xs">{i.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function UserMenu({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const initials = name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="flex shrink-0 items-center gap-2 rounded-lg py-1 pr-1 pl-1 hover:bg-[var(--hover)]">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">{initials || '?'}</span>
        <span className="hidden max-w-40 truncate text-sm font-medium sm:inline">{name.replace(/\s*\(.*\)$/, '')}</span>
        <ChevronDown size={16} className="muted hidden sm:inline" />
      </button>
      {open && (
        <div role="menu" className="surface absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl py-1 text-sm shadow-lg">
          <div className="border-b border-[var(--border)] px-4 py-2"><div className="truncate font-medium">{name}</div></div>
          <Link role="menuitem" href="/me" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 hover:bg-[var(--hover)]"><UserRound size={16} />My profile</Link>
          <Link role="menuitem" href="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 hover:bg-[var(--hover)]"><Settings size={16} />Account and security</Link>
          <button role="menuitem" type="button" className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-[var(--hover)]" onClick={async () => { await authPost('/auth/logout'); window.location.href = '/login'; }}><LogOut size={16} />Sign out</button>
        </div>
      )}
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { me, settings } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const groups = visibleNav(me.permissions);
  const isActive = isActiveFor(pathname);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (me.must_change_password && pathname !== '/account') router.replace('/account?change=1');
  }, [me.must_change_password, pathname, router]);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('silhr-sidebar') === 'collapsed'); } catch { /* ignore */ }
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const setCollapse = (c: boolean) => { setCollapsed(c); try { localStorage.setItem('silhr-sidebar', c ? 'collapsed' : 'open'); } catch { /* ignore */ } };

  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => unwrap(hr.GET('/api/v1/notifications')), refetchInterval: 60_000 });
  const unread = (notifications.data ?? []).filter((n) => !n.read_at).length;

  const orgCard = (
    <div className="mx-3 mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
      <div className="flex items-center gap-2 font-medium" style={{ color: 'var(--title)' }}><BriefcaseBusiness size={15} />{settings.organisation_name}</div>
      <div className="muted mt-1">{settings.currency} · {settings.timezone}</div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-white focus:p-2">Skip to content</a>
      <aside className={cx('hidden shrink-0 flex-col transition-[width] lg:flex', collapsed ? 'w-20' : 'w-64')}>
        <div className={cx('flex items-center px-6 py-5', collapsed ? 'justify-center px-0' : 'justify-between')}>
          <Link href="/" aria-label="SIL HR home"><Logo compact={collapsed} /></Link>
          {!collapsed && <button type="button" aria-label="Collapse the menu" title="Collapse the menu" onClick={() => setCollapse(true)} className="muted rounded-md p-1 hover:bg-[var(--hover)]"><PanelLeftClose size={18} /></button>}
        </div>
        {collapsed && <button type="button" aria-label="Expand the menu" title="Expand the menu" onClick={() => setCollapse(false)} className="muted mx-auto mb-2 rounded-md p-1 hover:bg-[var(--hover)]"><PanelLeftOpen size={18} /></button>}
        <div className="scroll-thin flex-1 overflow-y-auto"><Sidebar groups={groups} isActive={isActive} collapsed={collapsed} /></div>
        {!collapsed && orgCard}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="flex h-full w-72 flex-col bg-[var(--canvas)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5"><Logo /><button type="button" aria-label="Close menu" onClick={() => setDrawer(false)} className="muted rounded-md p-1 hover:bg-[var(--hover)]"><X size={18} /></button></div>
            <div className="scroll-thin flex-1 overflow-y-auto"><Sidebar groups={groups} isActive={isActive} collapsed={false} /></div>
            {orgCard}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-[var(--border)] bg-[var(--bg)] lg:my-2 lg:mr-2 lg:rounded-2xl lg:border">
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 sm:px-6">
          <button type="button" className="muted rounded-lg p-2 hover:bg-[var(--hover)] lg:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}><Menu size={20} /></button>
          <button type="button" onClick={() => setPalette(true)} className="muted flex w-full max-w-xs min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-left text-sm hover:bg-[var(--hover)]">
            <Search size={16} /><span className="flex-1">Search pages…</span><kbd className="hidden rounded border border-[var(--border)] px-1.5 text-xs sm:inline">⌘ K</kbd>
          </button>
          <div className="flex-1" />
          <button type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] hover:bg-[var(--hover)]">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <Link href="/notifications" aria-label={`Notifications, ${unread} unread`} className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] hover:bg-[var(--hover)]">
            <Bell size={18} />
            {unread > 0 && <span className="absolute -top-1 -right-1 min-w-5 rounded-full bg-red-500 px-1 text-center text-[11px] leading-5 font-medium text-white">{unread > 99 ? '99+' : unread}</span>}
          </Link>
          <UserMenu name={me.display_name} />
        </header>
        <main id="main" className="scroll-thin flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">{children}</div>
        </main>
      </div>
      {palette && <CommandPalette groups={groups} onClose={() => setPalette(false)} />}
    </div>
  );
}
