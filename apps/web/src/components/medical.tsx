'use client';

import { formatDate, formatMoney } from '@sil/hr-shared';
import { Badge, cx } from '@/components/ui';

export interface Bal {
  category_id: string; category_code: string; category_name: string; sharing: 'shared' | 'per_person'; limit: string; top_ups: string; carried_over: string; used: string; held: string; remaining: string;
  utilisation_pct: number; co_pay_pct: number; per_visit_cap: string | null; waiting_until: string | null; eligible: boolean;
}
export interface Member { id: string; member_number: string; name: string; relationship: string; status: string; cover_start: string; cover_end: string | null; scheme_name: string; staff_number: string }
export interface Cover extends Member { balances: Bal[]; holds: { id: string; member_id: string; category_code: string; amount: string; expires_on: string; reference: string | null }[]; family: Member[]; department: string | null }

const k = (x: string) => formatMoney(x, '');

/** One limit with a bar: used (solid) and held (striped) against the whole limit. */
export function LimitBar({ b, dateFormat }: { b: Bal; dateFormat: string }) {
  const total = Number(b.limit) + Number(b.top_ups) + Number(b.carried_over);
  const used = total > 0 ? Math.min(100, (Number(b.used) / total) * 100) : 0;
  const held = total > 0 ? Math.min(100 - used, (Number(b.held) / total) * 100) : 0;
  const tone = b.utilisation_pct >= 100 ? 'bg-red-500' : b.utilisation_pct >= 80 ? 'bg-amber-500' : 'bg-brand-500';
  return (
    <div className={cx('rounded-xl border border-[var(--border)] p-4', !b.eligible && 'opacity-60')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium" style={{ color: 'var(--title)' }}>{b.category_name}</div>
          <div className="muted text-xs">{b.sharing === 'shared' ? 'Shared by the family' : 'Each person'}{b.co_pay_pct ? ` · ${b.co_pay_pct}% co-pay` : ''}{b.per_visit_cap ? ` · up to ${k(b.per_visit_cap)} a visit` : ''}</div>
        </div>
        {!b.eligible ? <Badge value="not covered" /> : b.utilisation_pct >= 100 ? <Badge value="used up" /> : b.utilisation_pct >= 80 ? <Badge value="near limit" /> : null}
      </div>
      <div className="mt-3 text-xl font-semibold tabular-nums" style={{ color: 'var(--title)' }}>{formatMoney(b.remaining)} <span className="muted text-xs font-normal">left of {k(total.toFixed(2))}</span></div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-[var(--hover)]" role="img" aria-label={`${b.utilisation_pct}% used or held`}>
        <div className={tone} style={{ width: `${used}%` }} />
        <div className={cx(tone, 'opacity-40')} style={{ width: `${held}%` }} />
      </div>
      <div className="muted mt-2 flex flex-wrap justify-between gap-x-3 text-xs">
        <span>Used {k(b.used)}{Number(b.held) > 0 ? ` · held ${k(b.held)}` : ''}</span>
        {Number(b.top_ups) > 0 && <span>Top-ups {k(b.top_ups)}</span>}
        {b.waiting_until && b.waiting_until > new Date().toISOString().slice(0, 10) && <span>Waiting period until {formatDate(b.waiting_until, dateFormat)}</span>}
      </div>
    </div>
  );
}

export function CoverGrid({ cover, dateFormat }: { cover: Cover; dateFormat: string }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{cover.balances.map((b) => <LimitBar key={b.category_id} b={b} dateFormat={dateFormat} />)}</div>;
}

export const RELATIONSHIP: Record<string, string> = { principal: 'Staff member', spouse: 'Spouse', child: 'Child', other: 'Other' };
