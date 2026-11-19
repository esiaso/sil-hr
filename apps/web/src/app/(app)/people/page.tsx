'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, GENDERS, MARITAL_STATUSES, formatDate, hireEmployee, type HireEmployee } from '@sil/hr-shared';
import { Badge, Button, Dialog, Empty, Field, Input, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, newIdempotencyKey, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

function HireDialog({ onClose }: { onClose: () => void }) {
  const l = useLookups();
  const router = useRouter();
  const qc = useQueryClient();
  const [key] = useState(newIdempotencyKey);
  const form = useForm<HireEmployee>({ resolver: zodResolver(hireEmployee) as never, defaultValues: { employment_type: 'permanent', status: 'probation', hire_date: new Date().toISOString().slice(0, 10) } });
  // Existing staff already work here: they keep their staff number and original hire date, start as active, and get no onboarding checklist.
  const [existing, setExisting] = useState(false);
  const pick = (v: boolean) => {
    setExisting(v);
    form.setValue('status', v ? 'active' : 'probation');
    if (v) form.setValue('hire_date', '' as never);
    else form.setValue('hire_date', new Date().toISOString().slice(0, 10));
  };
  const save = useMutation({
    mutationFn: (v: HireEmployee) => {
      if (existing && !v.staff_number) { form.setError('staff_number', { message: 'Existing staff keep their staff number' }); throw new Error('Enter the staff number this person already has.'); }
      return unwrap(hr.POST('/api/v1/employees', { params: { header: { 'Idempotency-Key': key } as never }, body: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x])) as HireEmployee }));
    },
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ['employees'] });
      router.push(`/people/${e.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) for (const [p, m] of Object.entries(e.fieldErrors)) form.setError(p as keyof HireEmployee, { message: m });
    },
  });
  const err = form.formState.errors;
  const f = (name: keyof HireEmployee, label: string, type = 'text', hint?: string) => (
    <Field label={label} htmlFor={`h-${name}`} error={err[name]?.message} hint={hint}>
      <Input id={`h-${name}`} type={type} {...form.register(name, { setValueAs: (v) => (v === '' ? undefined : v) })} />
    </Field>
  );
  return (
    <Dialog open wide title="Add an employee" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="mb-4 flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Who are you adding">
        <label className="flex items-center gap-2"><input type="radio" checked={!existing} onChange={() => pick(false)} /> A new hire</label>
        <label className="flex items-center gap-2"><input type="radio" checked={existing} onChange={() => pick(true)} /> Someone who already works here</label>
      </div>
      {existing && <p className="muted mb-3 text-xs">Use their existing staff number and the date they actually joined. They start as active, and no onboarding checklist is created (that happens only for people who joined in the last 30 days). For many people at once, use People → Import &amp; export.</p>}
      <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {f('first_name', 'First name')}
          {f('middle_name', 'Middle name')}
          {f('last_name', 'Last name')}
          {f('national_id', 'National ID', 'text', 'Stored encrypted')}
          {f('kra_pin', 'KRA PIN')}
          {f('date_of_birth', 'Date of birth', 'date')}
          <Field label="Gender" htmlFor="h-gender"><Select id="h-gender" {...form.register('gender', { setValueAs: (v) => (v === '' ? undefined : v) })}><option value="">Not recorded</option>{GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}</Select></Field>
          <Field label="Marital status" htmlFor="h-marital"><Select id="h-marital" {...form.register('marital_status', { setValueAs: (v) => (v === '' ? undefined : v) })}><option value="">Not recorded</option>{MARITAL_STATUSES.map((g) => <option key={g} value={g}>{g}</option>)}</Select></Field>
          {f('work_email', 'Work email', 'email')}
          {f('work_phone', 'Work phone')}
          {f('staff_number', 'Staff number', 'text', existing ? 'Their current staff number' : 'Blank = next number')}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Position" htmlFor="h-position" error={err.position_id?.message}>
            <Select id="h-position" {...form.register('position_id')}>
              <option value="">Choose…</option>
              {l.positionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label="Employment type" htmlFor="h-type">
            <Select id="h-type" {...form.register('employment_type')}>{EMPLOYMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
          </Field>
          <Field label="Starts as" htmlFor="h-status">
            <Select id="h-status" {...form.register('status')}>{['onboarding', 'probation', 'active'].map((t) => <option key={t}>{t}</option>)}</Select>
          </Field>
          {f('hire_date', existing ? 'Date they joined' : 'Hire date', 'date')}
          {f('probation_end_date', 'Probation ends', 'date')}
        </div>
        <p className="muted text-xs">The manager is set on the profile after hiring. Other systems are told through hr.employee.hired.v1.</p>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={save.isPending}>{existing ? 'Add employee' : 'Hire'}</Button></div>
      </form>
    </Dialog>
  );
}

export default function EmployeesPage() {
  const { can, settings } = useSession();
  const l = useLookups();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [dept, setDept] = useState('');
  const [hiring, setHiring] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const q = useInfiniteQuery({
    queryKey: ['employees', debounced, status, type, dept],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(hr.GET('/api/v1/employees', { params: { query: { limit: 50, cursor: pageParam, search: debounced || undefined, status: (status || undefined) as never, employment_type: (type || undefined) as never, department_id: dept || undefined, include_sub_departments: dept ? 'true' : undefined } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => (q.data?.pages.flatMap((p) => p.data) ?? []).filter((e) => !('deleted' in e)), [q.data]);
  return (
    <div>
      <PageHeader title="Employees" description="Everyone the hospital employs, within your scope. Search by name, staff number, work email, or an exact national ID or KRA PIN." actions={can('employee:hire') && <Button onClick={() => setHiring(true)}>Add employee</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-40"><option value="">Any status</option>{EMPLOYEE_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select>
        <Select aria-label="Employment type" value={type} onChange={(e) => setType(e.target.value)} className="max-w-40"><option value="">Any type</option>{EMPLOYMENT_TYPES.map((s) => <option key={s}>{s}</option>)}</Select>
        <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="max-w-60"><option value="">Any department</option>{l.departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
      </div>
      <ProblemBanner error={q.error} />
      <div className="surface overflow-x-auto rounded-xl">
        {q.isLoading ? <Loading /> : !rows.length ? <Empty>No employees match.</Empty> : (
          <table className="data">
            <thead><tr><th>Staff no.</th><th>Name</th><th>Position</th><th>Department</th><th>Type</th><th>Status</th><th>Licence</th><th>Hired</th></tr></thead>
            <tbody>
              {rows.map((e) => 'staff_number' in e && (
                <tr key={e.id}>
                  <td className="font-mono text-xs">{e.staff_number}</td>
                  <td><Link className="text-brand-600 hover:underline" href={`/people/${e.id}`}>{e.display_name}</Link></td>
                  <td>{e.position_id ? l.positions.get(e.position_id)?.title : ''}</td>
                  <td>{e.department_id ? l.departments.get(e.department_id)?.name : ''}</td>
                  <td>{e.employment_type}</td>
                  <td><Badge value={e.status} /></td>
                  <td>{e.licence_status && <Badge value={e.licence_status} />}</td>
                  <td className="text-xs">{formatDate(e.hire_date, settings.date_format)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <LoadMore hasMore={!!q.hasNextPage} busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
      {hiring && <HireDialog onClose={() => setHiring(false)} />}
    </div>
  );
}
