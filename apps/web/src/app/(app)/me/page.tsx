'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MARITAL_STATUSES, formatDate, formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

/** Self-service: works on a phone. */
export default function MePage() {
  const { settings } = useSession();
  const l = useLookups();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me', 'employee'], queryFn: () => unwrap(hr.GET('/api/v1/me/employee')), retry: false });
  // Position and department names from the directory (employees may not read the organisation lists).
  const dir = useQuery({ queryKey: ['me', 'directory', me.data?.id], enabled: !!me.data, queryFn: () => unwrap(hr.GET('/api/v1/directory/staff/{id}', { params: { path: { id: me.data!.id } } })) });
  const licences = useQuery({ queryKey: ['me', 'licences'], enabled: !!me.data, queryFn: () => unwrap(hr.GET('/api/v1/me/licences')) });
  const team = useQuery({ queryKey: ['me', 'team'], enabled: !!me.data, queryFn: () => unwrap(hr.GET('/api/v1/me/team')) });
  const changes = useQuery({ queryKey: ['me', 'changes'], enabled: !!me.data, queryFn: () => unwrap(hr.GET('/api/v1/me/contact-changes')) });
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  const submit = useMutation({
    mutationFn: () => unwrap(hr.POST('/api/v1/me/contact-changes', { body: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '')) as never })),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  const cancel = useMutation({ mutationFn: (id: string) => unwrap(hr.POST('/api/v1/me/contact-changes/{id}/cancel', { params: { path: { id } } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'changes'] }) });
  const df = (d: string | null | undefined) => formatDate(d, settings.date_format);

  if (me.error instanceof ApiError && me.error.status === 404) return <div><PageHeader title="My profile" /><Empty>Your account is not linked to an employee record. Ask HR to link it.</Empty></div>;
  if (!me.data) return me.error ? <ProblemBanner error={me.error} /> : <Loading />;
  const e = me.data;
  const pending = changes.data?.find((c) => c.status === 'pending');
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title={e.display_name} description={[e.staff_number, dir.data?.position_title].filter(Boolean).join(' · ')} />
      <Card>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">My details</h2>{!pending && <Button variant="secondary" onClick={() => { setV({ personal_email: e.personal_email ?? '', personal_phone: e.personal_phone ?? '', postal_address: e.postal_address ?? '', residential_address: e.residential_address ?? '', marital_status: e.marital_status ?? '' }); setEditing(true); }}>Request a change</Button>}</div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {[['Department', dir.data?.department_name ?? (e.department_id ? l.departments.get(e.department_id)?.name : '')], ['Hired', df(e.hire_date)], ['Employment', e.employment_type], ['Status', e.status], ['National ID', e.national_id], ['KRA PIN', e.kra_pin], ['NSSF', e.nssf_number], ['SHA', e.sha_number], ['Work email', e.work_email], ['Personal email', e.personal_email], ['Personal phone', e.personal_phone], ['Residence', e.residential_address]].map(([k, val]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-[var(--border)] py-1"><dt className="muted">{k}</dt><dd className="text-right">{val || '—'}</dd></div>
          ))}
        </dl>
        {pending && (
          <div className="mt-3 rounded-md bg-sky-50 p-3 text-sm dark:bg-sky-950/40">
            You asked to change {Object.keys(pending.changes).map((k) => k.replace(/_/g, ' ')).join(', ')} on {formatDateTime(pending.submitted_at, settings.timezone, settings.date_format)}. HR will review it.
            <Button variant="ghost" onClick={() => cancel.mutate(pending.id)}>Cancel request</Button>
          </div>
        )}
      </Card>
      {licences.data && licences.data.length > 0 && (
        <Card>
          <h2 className="mb-2 font-semibold">My licences</h2>
          <ul className="text-sm">{licences.data.map((x) => <li key={x.id} className="flex justify-between border-b border-[var(--border)] py-1"><span>{x.licensing_body} {x.licence_number}</span><span>expires {df(x.expiry_date)} {!x.verified && <Badge value="not_verified" />}</span></li>)}</ul>
        </Card>
      )}
      {team.data && team.data.length > 0 && (
        <Card>
          <h2 className="mb-2 font-semibold">My team</h2>
          <ul className="text-sm">{team.data.map((t) => <li key={t.id} className="flex flex-wrap justify-between gap-2 border-b border-[var(--border)] py-1"><span>{t.display_name} <span className="muted">{t.position_title}</span></span><span><Badge value={t.status} /> {t.licence_status && t.licence_status !== 'valid' && <Badge value={`licence ${t.licence_status}`} />}</span></li>)}</ul>
        </Card>
      )}
      <p className="muted text-xs">Leave, payslips, clock-in and your roster arrive with the next releases.</p>
      {editing && (
        <Dialog open title="Request a change" onClose={() => setEditing(false)}>
          <ProblemBanner error={submit.error} />
          <div className="space-y-3">
            {(['personal_email', 'personal_phone', 'postal_address', 'residential_address'] as const).map((k) => <Field key={k} label={k.replace(/_/g, ' ')} htmlFor={`me-${k}`}><Input id={`me-${k}`} value={v[k] ?? ''} onChange={(x) => setV({ ...v, [k]: x.target.value })} /></Field>)}
            <Field label="Marital status" htmlFor="me-ms"><Select id="me-ms" value={v.marital_status ?? ''} onChange={(x) => setV({ ...v, marital_status: x.target.value })}><option value="">—</option>{MARITAL_STATUSES.map((m) => <option key={m}>{m}</option>)}</Select></Field>
            <p className="muted text-xs">HR checks changes before they apply.</p>
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button><Button busy={submit.isPending} onClick={() => submit.mutate()}>Send to HR</Button></div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
