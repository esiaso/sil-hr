'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, type LeaveType } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const NUM_FIELDS: [keyof LeaveType, string][] = [
  ['default_entitlement_days', 'Days per year'], ['pay_rate', 'Pay rate (1 = full, 0.5 = half)'], ['carry_forward_max_days', 'Carry forward at most'], ['carry_forward_expiry_months', 'Carried days expire after (months)'],
  ['min_notice_days', "Notice (days)"], ['min_service_months', 'Service before eligible (months)'], ['max_consecutive_days', 'At most per request'], ['requires_document_over_days', 'Document needed over (days)'],
];

function TypeDialog({ t, onClose }: { t: LeaveType; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<LeaveType>(t);
  const save = useMutation({
    mutationFn: () => unwrap(hr.PUT('/api/v1/leave/types/{id}', { params: { path: { id: t.id }, header: { 'If-Match': `"${t.version}"` } }, body: { ...v, gender: v.gender, colour: v.colour } as never })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['leave-types-all'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={t.name} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" htmlFor="lt-name"><Input id="lt-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Counts" htmlFor="lt-count"><Select id="lt-count" value={v.counting} onChange={(e) => setV({ ...v, counting: e.target.value as LeaveType['counting'] })}><option value="working_days">Working days (skip rest days and holidays)</option><option value="calendar_days">Calendar days</option></Select></Field>
        <Field label="Granted" htmlFor="lt-acc"><Select id="lt-acc" value={v.accrual} onChange={(e) => setV({ ...v, accrual: e.target.value as LeaveType['accrual'] })}><option value="monthly">Monthly (1/12 each month)</option><option value="annual">At the start of the year (prorated for joiners)</option><option value="none">A yearly allowance</option></Select></Field>
        {NUM_FIELDS.map(([k, label]) => (
          <Field key={k} label={label} htmlFor={`lt-${k}`} error={fe[k]}><Input id={`lt-${k}`} type="number" step="0.5" value={(v[k] as number | null) ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
        ))}
        <Field label="Only for" htmlFor="lt-gender"><Select id="lt-gender" value={v.gender ?? ''} onChange={(e) => setV({ ...v, gender: (e.target.value || null) as LeaveType['gender'] })}><option value="">Everyone</option><option value="female">Women</option><option value="male">Men</option></Select></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        {([['is_paid', 'Paid'], ['allow_half_day', 'Half days allowed'], ['allow_negative_balance', 'May go below zero'], ['encashable', 'Can be paid out']] as const).map(([k, label]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={v[k] as boolean} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />{label}</label>)}
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.status === 'active'} onChange={(e) => setV({ ...v, status: e.target.checked ? 'active' : 'inactive' })} />In use</label>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

export default function LeaveSetupPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['leave-types-all'], queryFn: () => unwrap(hr.GET('/api/v1/leave/types', { params: { query: { include_inactive: 'true' } as never } })) });
  const year = new Date().getFullYear();
  const [hy, setHy] = useState(year);
  const holidays = useQuery({ queryKey: ['holidays', hy], queryFn: () => unwrap(hr.GET('/api/v1/leave/holidays', { params: { query: { year: String(hy) } as never } })) });
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [h, setH] = useState({ date: '', name: '' });
  const addHoliday = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/leave/holidays', { body: h })), onSuccess: () => { setH({ date: '', name: '' }); void qc.invalidateQueries({ queryKey: ['holidays'] }); } });
  const removeHoliday = useMutation({ mutationFn: (id: string) => unwrap(hr.DELETE('/api/v1/leave/holidays/{id}', { params: { path: { id } } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }) });
  return (
    <div className="space-y-4">
      <PageHeader title="Leave setup" description="Leave types and public holidays. The starting values follow the Employment Act minimums; set them to the hospital's policy. Approval chains are under Administration → Approval workflows." />
      <ProblemBanner error={types.error ?? addHoliday.error ?? removeHoliday.error} />
      <Card>
        <h2 className="mb-2 font-semibold">Leave types</h2>
        {!types.data ? <Loading /> : (
          <table className="data">
            <thead><tr><th>Type</th><th>Days</th><th>Granted</th><th>Counts</th><th>Carry over</th><th>Pay</th><th /></tr></thead>
            <tbody>{types.data.map((t) => <tr key={t.id}><td><span className="mr-2 inline-block h-3 w-3 rounded-full align-middle" style={{ background: t.colour ?? '#888' }} />{t.name} {t.status === 'inactive' && <Badge value="inactive" />}<div className="muted max-w-md text-xs">{t.description}</div></td><td>{t.default_entitlement_days}</td><td>{t.accrual}</td><td>{t.counting.replace('_', ' ')}</td><td>{t.carry_forward_max_days || ''}</td><td>{t.is_paid ? (t.pay_rate < 1 ? `${t.pay_rate * 100}%` : 'full') : 'unpaid'}</td><td><Button variant="ghost" onClick={() => setEditing(t)}>Edit</Button></td></tr>)}</tbody>
          </table>
        )}
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Public holidays</h2><Select aria-label="Year" value={hy} onChange={(e) => setHy(Number(e.target.value))} className="max-w-28">{[year - 1, year, year + 1].map((y) => <option key={y}>{y}</option>)}</Select></div>
        <p className="muted mb-2 text-xs">Check each year against the Kenya Gazette; add Eid al-Fitr and any special holiday when it is gazetted. Holidays are not taken from working-day leave.</p>
        {!holidays.data ? <Loading /> : <ul className="mb-3 text-sm">{holidays.data.map((x) => <li key={x.id} className="flex justify-between border-b border-[var(--border)] py-1"><span>{formatDate(x.date, settings.date_format)} · {x.name}</span><Button variant="ghost" onClick={() => removeHoliday.mutate(x.id)}>Remove</Button></li>)}</ul>}
        <div className="flex flex-wrap items-end gap-2"><Field label="Date" htmlFor="ph-date"><Input id="ph-date" type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} /></Field><Field label="Name" htmlFor="ph-name"><Input id="ph-name" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} /></Field><Button disabled={!h.date || !h.name} onClick={() => addHoliday.mutate()}>Add</Button></div>
      </Card>
      {editing && <TypeDialog t={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
