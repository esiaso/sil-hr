'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import { EMPLOYMENT_TYPES, GENDERS, MARITAL_STATUSES, RELATIONSHIPS, STATUS_TRANSITIONS, formatDate, type Employee, type EmployeeStatus } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, cx } from '@/components/ui';
import { ApiError, hr, unwrap, withEtag } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';
import { EmployeeLogin } from '@/components/employee-login';
import { PullAttendance } from '@/components/pull-attendance';

const TABS = ['overview', 'job', 'contacts', 'family', 'qualifications', 'payment', 'documents', 'licences'] as const;
type Tab = (typeof TABS)[number];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1 text-sm">
      <dt className="muted">{label}</dt>
      <dd>{children || <span className="muted">—</span>}</dd>
    </div>
  );
}

/** Small generic editor for the per-employee lists (contacts, dependants, qualifications, payment). */
function ListEditor<T extends { id: string }>({
  title, rows, columns, fields, onAdd, onRemove, canEdit, empty,
}: {
  title: string;
  rows: T[] | undefined;
  columns: { label: string; value: (r: T) => ReactNode }[];
  fields: { name: string; label: string; type?: 'text' | 'date' | 'number' | 'checkbox'; options?: readonly string[] }[];
  onAdd: (v: Record<string, unknown>) => Promise<unknown>;
  onRemove?: (id: string) => Promise<unknown>;
  canEdit: boolean;
  empty: string;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<unknown>(null);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        {canEdit && <Button variant="secondary" onClick={() => { setValues({}); setOpen(true); }}>Add</Button>}
      </div>
      {!rows ? <Loading /> : !rows.length ? <Empty>{empty}</Empty> : (
        <table className="data">
          <thead><tr>{columns.map((c) => <th key={c.label}>{c.label}</th>)}{canEdit && onRemove && <th />}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {columns.map((c) => <td key={c.label}>{c.value(r)}</td>)}
                {canEdit && onRemove && <td><Button variant="ghost" onClick={() => onRemove(r.id).catch(setError)}>Remove</Button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <Dialog open title={`Add ${title.toLowerCase().replace(/s$/, '')}`} onClose={() => setOpen(false)}>
          <ProblemBanner error={error} />
          <div className="space-y-3">
            {fields.map((f) => (
              <Field key={f.name} label={f.label} htmlFor={`le-${f.name}`} error={error instanceof ApiError ? error.fieldErrors[f.name] : undefined}>
                {f.options ? (
                  <Select id={`le-${f.name}`} value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value || undefined })}>
                    <option value="">—</option>
                    {f.options.map((o) => <option key={o}>{o}</option>)}
                  </Select>
                ) : f.type === 'checkbox' ? (
                  <input id={`le-${f.name}`} type="checkbox" checked={!!values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
                ) : (
                  <Input id={`le-${f.name}`} type={f.type ?? 'text'} value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value === '' ? undefined : f.type === 'number' ? Number(e.target.value) : e.target.value })} />
                )}
              </Field>
            ))}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={async () => { setError(null); try { await onAdd(values); setOpen(false); } catch (e) { setError(e); } }}>Save</Button>
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function Profile() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (TABS.includes(sp.get('tab') as Tab) ? sp.get('tab') : 'overview') as Tab;
  const { can, settings } = useSession();
  const l = useLookups();
  const qc = useQueryClient();
  const [reveal, setReveal] = useState(false);
  const [dialog, setDialog] = useState<'edit' | 'status' | 'transfer' | 'manager' | null>(null);
  const [pulling, setPulling] = useState(false);
  const df = (d: string | null | undefined) => formatDate(d, settings.date_format);

  const emp = useQuery({ queryKey: ['employee', id, reveal], queryFn: () => withEtag(hr.GET('/api/v1/employees/{id}', { params: { path: { id }, query: { include_sensitive: reveal ? 'true' : undefined } as never } })) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['employee', id] });
  const sub = <T,>(key: string, enabled: boolean, fn: () => Promise<T>) => useQuery({ queryKey: ['employee', id, key], enabled, queryFn: fn });
  const history = sub('history', tab === 'job', () => unwrap(hr.GET('/api/v1/employees/{id}/history', { params: { path: { id } } })));
  const contacts = sub('contacts', tab === 'contacts', () => unwrap(hr.GET('/api/v1/employees/{id}/contacts', { params: { path: { id } } })));
  const dependants = sub('dependants', tab === 'family', () => unwrap(hr.GET('/api/v1/employees/{id}/dependants', { params: { path: { id } } })));
  const quals = sub('qualifications', tab === 'qualifications', () => unwrap(hr.GET('/api/v1/employees/{id}/qualifications', { params: { path: { id } } })));
  const banks = sub(`banks-${reveal}`, tab === 'payment', () => unwrap(hr.GET('/api/v1/employees/{id}/bank-accounts', { params: { path: { id }, query: { include_sensitive: reveal ? 'true' : undefined } as never } })));
  const checklist = sub('checklist', tab === 'documents', () => unwrap(hr.GET('/api/v1/employees/{id}/documents/checklist', { params: { path: { id } } })));
  const licences = sub('licences', tab === 'licences' && can('licence:read'), () => unwrap(hr.GET('/api/v1/employees/{id}/licences', { params: { path: { id } } })));

  if (!emp.data) return emp.error ? <ProblemBanner error={emp.error} /> : <Loading />;
  const e = emp.data.data;
  const canEdit = can('employee:update') && e.status !== 'exited';
  const canLifecycle = can('employee:lifecycle') && e.status !== 'exited';
  const pos = e.position_id ? l.positions.get(e.position_id) : undefined;
  const dep = e.department_id ? l.departments.get(e.department_id) : undefined;

  return (
    <div>
      <PageHeader
        title={e.display_name}
        description={`${e.staff_number} · ${pos?.title ?? 'No position'} · ${dep?.name ?? ''}`}
        actions={
          <>
            <Badge value={e.status} />
            {e.licence_status && <Badge value={`licence ${e.licence_status}`} />}
            {canEdit && <Button variant="secondary" onClick={() => setDialog('edit')}>Edit</Button>}
            {canLifecycle && <Button variant="secondary" onClick={() => setDialog('transfer')}>Transfer</Button>}
            {canLifecycle && <Button variant="secondary" onClick={() => setDialog('manager')}>Manager</Button>}
            {canLifecycle && <Button variant="secondary" onClick={() => setDialog('status')}>Change status</Button>}
            {can('attendance:manage') && e.status !== 'exited' && <Button variant="secondary" onClick={() => setPulling(true)}>Pull attendance</Button>}
          </>
        }
      />
      <nav className="mb-4 flex flex-wrap gap-1 border-b border-[var(--border)]" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => router.replace(`/people/${id}?tab=${t}`)} className={cx('-mb-px border-b-2 px-3 py-2 text-sm capitalize', tab === t ? 'border-brand-600 font-medium' : 'muted border-transparent hover:text-[var(--text)]')}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold">Personal</h3>
              {can('employee.sensitive:read') && <Button variant="ghost" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Show'} ID numbers</Button>}
            </div>
            <dl>
              <Row label="Gender">{e.gender}</Row>
              <Row label="Date of birth">{df(e.date_of_birth)}</Row>
              <Row label="Marital status">{e.marital_status}</Row>
              <Row label="Nationality">{e.nationality}</Row>
              <Row label="National ID"><span className="font-mono">{e.national_id}</span></Row>
              <Row label="Passport"><span className="font-mono">{e.passport_number}</span></Row>
              <Row label="KRA PIN"><span className="font-mono">{e.kra_pin}</span></Row>
              <Row label="NSSF number">{e.nssf_number}</Row>
              <Row label="SHA number">{e.sha_number}</Row>
            </dl>
            {reveal && e.sensitive_visible && <p className="muted mt-2 text-xs">This view of ID numbers was recorded in the audit trail.</p>}
          </Card>
          <EmployeeLogin e={e} onChanged={refresh} />
          <Card>
            <h3 className="mb-2 font-semibold">Contact</h3>
            <dl>
              <Row label="Work email">{e.work_email}</Row>
              <Row label="Work phone">{e.work_phone}</Row>
              <Row label="Personal email">{e.personal_email}</Row>
              <Row label="Personal phone">{e.personal_phone}</Row>
              <Row label="Postal address">{e.postal_address}</Row>
              <Row label="Residence">{e.residential_address}</Row>
            </dl>
          </Card>
          <Card>
            <h3 className="mb-2 font-semibold">Employment</h3>
            <dl>
              <Row label="Type">{e.employment_type}</Row>
              <Row label="Hired">{df(e.hire_date)}</Row>
              <Row label="Probation ends">{df(e.probation_end_date)}</Row>
              <Row label="Exit">{e.exit_date ? `${df(e.exit_date)}: ${e.exit_reason}` : ''}</Row>
              <Row label="Branch">{e.branch_id ? l.branches.get(e.branch_id)?.name : ''}</Row>
              <Row label="Cost centre">{e.cost_centre_id ? l.costCentres.get(e.cost_centre_id)?.code : ''}</Row>
              <Row label="Manager">{e.manager_id ? <Link className="text-brand-600 hover:underline" href={`/people/${e.manager_id}`}>View manager</Link> : ''}</Row>
              <Row label="Login">{e.user_id ? 'Linked' : 'None'}</Row>
            </dl>
          </Card>
        </div>
      )}

      {tab === 'job' && (
        <div className="space-y-4">
          <Card>
            <h3 className="mb-2 font-semibold">Position history</h3>
            {!history.data ? <Loading /> : (
              <table className="data">
                <thead><tr><th>From</th><th>To</th><th>Position</th><th>Department</th><th>Reason</th></tr></thead>
                <tbody>{history.data.assignments.map((a) => <tr key={a.id}><td>{df(a.effective_from)}</td><td>{a.effective_to ? df(a.effective_to) : 'current'}</td><td>{l.positions.get(a.position_id)?.title}</td><td>{l.departments.get(a.department_id)?.name}</td><td>{a.reason}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
          <Card>
            <h3 className="mb-2 font-semibold">Status history</h3>
            {!history.data ? <Loading /> : (
              <table className="data">
                <thead><tr><th>Effective</th><th>Change</th><th>Reason</th></tr></thead>
                <tbody>{history.data.statuses.map((s) => <tr key={s.id}><td>{df(s.effective_date)}</td><td>{s.from_status ? `${s.from_status} → ` : ''}{s.to_status}</td><td>{s.reason}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </div>
      )}

      {tab === 'contacts' && (
        <ListEditor
          title="Next of kin and emergency contacts" rows={contacts.data} canEdit={canEdit} empty="No contacts recorded."
          columns={[{ label: 'Kind', value: (c) => c.kind.replace('_', ' ') }, { label: 'Name', value: (c) => c.name }, { label: 'Relationship', value: (c) => c.relationship }, { label: 'Phone', value: (c) => c.phone }, { label: 'Primary', value: (c) => (c.is_primary ? 'Yes' : '') }]}
          fields={[{ name: 'kind', label: 'Kind', options: ['next_of_kin', 'emergency'] }, { name: 'name', label: 'Name' }, { name: 'relationship', label: 'Relationship', options: RELATIONSHIPS }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' }, { name: 'is_primary', label: 'Primary', type: 'checkbox' }]}
          onAdd={async (v) => { await unwrap(hr.POST('/api/v1/employees/{id}/contacts', { params: { path: { id } }, body: v as never })); void contacts.refetch(); }}
          onRemove={async (rid) => { await unwrap(hr.DELETE('/api/v1/employees/{id}/contacts/{rid}', { params: { path: { id, rid } } })); void contacts.refetch(); }}
        />
      )}

      {tab === 'family' && (
        <ListEditor
          title="Dependants" rows={dependants.data} canEdit={canEdit} empty="No dependants recorded."
          columns={[{ label: 'Name', value: (d) => d.name }, { label: 'Relationship', value: (d) => d.relationship }, { label: 'Born', value: (d) => df(d.date_of_birth) }, { label: 'Medical beneficiary', value: (d) => (d.is_beneficiary ? 'Yes' : '') }]}
          fields={[{ name: 'name', label: 'Name' }, { name: 'relationship', label: 'Relationship', options: RELATIONSHIPS }, { name: 'date_of_birth', label: 'Date of birth', type: 'date' }, { name: 'gender', label: 'Gender', options: GENDERS }, { name: 'is_beneficiary', label: 'Medical beneficiary', type: 'checkbox' }]}
          onAdd={async (v) => { await unwrap(hr.POST('/api/v1/employees/{id}/dependants', { params: { path: { id } }, body: v as never })); void dependants.refetch(); }}
          onRemove={async (rid) => { await unwrap(hr.DELETE('/api/v1/employees/{id}/dependants/{rid}', { params: { path: { id, rid } } })); void dependants.refetch(); }}
        />
      )}

      {tab === 'qualifications' && (
        <ListEditor
          title="Qualifications" rows={quals.data} canEdit={canEdit} empty="No qualifications recorded."
          columns={[{ label: 'Level', value: (q) => q.level }, { label: 'Title', value: (q) => q.title }, { label: 'Institution', value: (q) => q.institution }, { label: 'Year', value: (q) => q.year_awarded }]}
          fields={[{ name: 'level', label: 'Level', options: ['certificate', 'diploma', 'higher_diploma', 'degree', 'masters', 'doctorate', 'professional', 'other'] }, { name: 'title', label: 'Title' }, { name: 'institution', label: 'Institution' }, { name: 'year_awarded', label: 'Year awarded', type: 'number' }]}
          onAdd={async (v) => { await unwrap(hr.POST('/api/v1/employees/{id}/qualifications', { params: { path: { id } }, body: v as never })); void quals.refetch(); }}
          onRemove={async (rid) => { await unwrap(hr.DELETE('/api/v1/employees/{id}/qualifications/{rid}', { params: { path: { id, rid } } })); void quals.refetch(); }}
        />
      )}

      {tab === 'payment' && (
        <ListEditor
          title="Bank and mobile-money accounts" rows={banks.data} canEdit={canEdit} empty="No payment details recorded."
          columns={[{ label: 'Kind', value: (b) => b.kind.replace('_', ' ') }, { label: 'Bank', value: (b) => b.bank_name }, { label: 'Account name', value: (b) => b.account_name }, { label: 'Number', value: (b) => <span className="font-mono">{b.account_number}</span> }, { label: 'Primary', value: (b) => (b.is_primary ? 'Yes' : '') }]}
          fields={[{ name: 'kind', label: 'Kind', options: ['bank', 'mobile_money'] }, { name: 'bank_name', label: 'Bank' }, { name: 'branch_name', label: 'Branch' }, { name: 'account_name', label: 'Account name' }, { name: 'account_number', label: 'Account or M-Pesa number' }, { name: 'is_primary', label: 'Primary (salary is paid here)', type: 'checkbox' }]}
          onAdd={async (v) => { await unwrap(hr.POST('/api/v1/employees/{id}/bank-accounts', { params: { path: { id } }, body: v as never })); void banks.refetch(); }}
          onRemove={async (rid) => { await unwrap(hr.DELETE('/api/v1/employees/{id}/bank-accounts/{rid}', { params: { path: { id, rid } } })); void banks.refetch(); }}
        />
      )}

      {tab === 'documents' && <DocumentsTab employeeId={id} checklist={checklist.data} reload={() => void checklist.refetch()} canEdit={canEdit} canVerify={can('employee_document:verify')} />}

      {tab === 'licences' && (
        <LicencesTab employeeId={id} rows={licences.data} canManage={can('licence:manage')} canVerify={can('licence:verify')} reload={() => { void licences.refetch(); refresh(); }} />
      )}

      {pulling && <PullAttendance employeeId={e.id} name={e.display_name} onClose={() => setPulling(false)} />}
      {dialog === 'edit' && <EditDialog e={e} etag={emp.data.etag} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'status' && <StatusDialog e={e} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'transfer' && <TransferDialog e={e} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'manager' && <ManagerDialog e={e} onClose={() => { setDialog(null); refresh(); }} />}
    </div>
  );
}

function useAction<T>(fn: () => Promise<T>, onDone: () => void) {
  return useMutation({ mutationFn: fn, onSuccess: onDone });
}

function EditDialog({ e, etag, onClose }: { e: Employee; etag: string; onClose: () => void }) {
  const fields = ['first_name', 'middle_name', 'last_name', 'work_email', 'work_phone', 'personal_email', 'personal_phone', 'postal_address', 'residential_address', 'nationality', 'nssf_number', 'sha_number', 'date_of_birth'] as const;
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f, (e[f] as string | null) ?? ''])));
  const [type, setType] = useState(e.employment_type);
  const [gender, setGender] = useState<string>(e.gender ?? '');
  const [marital, setMarital] = useState<string>(e.marital_status ?? '');
  const [ids, setIds] = useState({ national_id: '', kra_pin: '', passport_number: '' });
  const save = useAction(
    () => unwrap(hr.PATCH('/api/v1/employees/{id}', {
      params: { path: { id: e.id }, header: { 'If-Match': etag } },
      body: { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x])), employment_type: type, gender: gender || null, marital_status: marital || null, ...Object.fromEntries(Object.entries(ids).filter(([, x]) => x)) } as never,
    })),
    onClose,
  );
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title="Edit employee" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        {fields.map((f) => <Field key={f} label={f.replace(/_/g, ' ')} htmlFor={`e-${f}`} error={fe[f]}><Input id={`e-${f}`} type={f === 'date_of_birth' ? 'date' : 'text'} value={v[f]} onChange={(x) => setV({ ...v, [f]: x.target.value })} /></Field>)}
        <Field label="Gender" htmlFor="e-gender"><Select id="e-gender" value={gender} onChange={(x) => setGender(x.target.value)}><option value="">Not recorded</option>{GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}</Select></Field>
        <Field label="Marital status" htmlFor="e-marital"><Select id="e-marital" value={marital} onChange={(x) => setMarital(x.target.value)}><option value="">Not recorded</option>{MARITAL_STATUSES.map((g) => <option key={g} value={g}>{g}</option>)}</Select></Field>
        <Field label="Employment type" htmlFor="e-type"><Select id="e-type" value={type} onChange={(x) => setType(x.target.value as typeof type)}>{EMPLOYMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        {(['national_id', 'kra_pin', 'passport_number'] as const).map((f) => <Field key={f} label={`New ${f.replace(/_/g, ' ')}`} htmlFor={`e-${f}`} hint="Leave blank to keep" error={fe[f]}><Input id={`e-${f}`} value={ids[f]} onChange={(x) => setIds({ ...ids, [f]: x.target.value })} /></Field>)}
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

function StatusDialog({ e, onClose }: { e: Employee; onClose: () => void }) {
  const next = STATUS_TRANSITIONS[e.status as EmployeeStatus];
  const [status, setStatus] = useState(next[0]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const save = useAction(() => unwrap(hr.POST('/api/v1/employees/{id}/status', { params: { path: { id: e.id } }, body: { status, effective_date: date, reason } })), onClose);
  return (
    <Dialog open title="Change status" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="space-y-3">
        <Field label="New status" htmlFor="s-status"><Select id="s-status" value={status} onChange={(x) => setStatus(x.target.value as EmployeeStatus)}>{next.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Effective date" htmlFor="s-date"><Input id="s-date" type="date" value={date} onChange={(x) => setDate(x.target.value)} /></Field>
        <Field label="Reason" htmlFor="s-reason"><Input id="s-reason" value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
        {status === 'exited' && <p className="text-sm text-amber-700">Exiting ends the current position, disables their login at once, and tells other systems (SCIM shows them inactive).</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={status === 'exited' ? 'danger' : 'primary'} busy={save.isPending} onClick={() => save.mutate()}>Confirm</Button></div>
      </div>
    </Dialog>
  );
}

function TransferDialog({ e, onClose }: { e: Employee; onClose: () => void }) {
  const l = useLookups();
  const [position, setPosition] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const save = useAction(() => unwrap(hr.POST('/api/v1/employees/{id}/transfers', { params: { path: { id: e.id } }, body: { position_id: position, effective_from: date, reason } })), onClose);
  return (
    <Dialog open title="Transfer" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="space-y-3">
        <Field label="New position" htmlFor="t-pos"><Select id="t-pos" value={position} onChange={(x) => setPosition(x.target.value)}><option value="">Choose…</option>{l.positionOptions.filter((o) => o.value !== e.position_id).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        <Field label="Effective from" htmlFor="t-date" hint="A future date takes effect on that day"><Input id="t-date" type="date" value={date} onChange={(x) => setDate(x.target.value)} /></Field>
        <Field label="Reason" htmlFor="t-reason"><Input id="t-reason" value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!position} onClick={() => save.mutate()}>Transfer</Button></div>
      </div>
    </Dialog>
  );
}

function ManagerDialog({ e, onClose }: { e: Employee; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const people = useQuery({ queryKey: ['manager-search', search], enabled: search.length > 1, queryFn: () => unwrap(hr.GET('/api/v1/directory/staff', { params: { query: { search, limit: 10 } } })) });
  const save = useMutation({ mutationFn: (managerId: string | null) => unwrap(hr.PUT('/api/v1/employees/{id}/manager', { params: { path: { id: e.id } }, body: { manager_id: managerId } })), onSuccess: onClose });
  return (
    <Dialog open title="Line manager" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <Field label="Search staff" htmlFor="m-search"><Input id="m-search" value={search} onChange={(x) => setSearch(x.target.value)} placeholder="Name or staff number" /></Field>
      <ul className="mt-3 space-y-1">
        {people.data?.data.filter((p) => 'staff_number' in p && p.id !== e.id).map((p) => 'staff_number' in p && (
          <li key={p.id} className="flex items-center justify-between text-sm"><span>{p.display_name} <span className="muted">{p.position_title}</span></span><Button variant="secondary" onClick={() => save.mutate(p.id)}>Choose</Button></li>
        ))}
      </ul>
      {e.manager_id && <div className="mt-3"><Button variant="ghost" onClick={() => save.mutate(null)}>Remove manager</Button></div>}
    </Dialog>
  );
}

function DocumentsTab({ employeeId, checklist, reload, canEdit, canVerify }: { employeeId: string; checklist?: { document_type_id: string; name: string; required: boolean; state: string; employee_document_id: string | null }[]; reload: () => void; canEdit: boolean; canVerify: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const upload = async (typeId: string, file: File) => {
    setError(null);
    try {
      const body = new FormData();
      body.set('owner_type', 'employee');
      body.set('owner_id', employeeId);
      body.set('title', file.name);
      body.set('file', file);
      const res = await fetch('/api/v1/documents', { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
      if (!res.ok) throw new ApiError(res.status, await res.json());
      const doc = await res.json();
      const expiry = window.prompt('Expiry date (YYYY-MM-DD), if the document expires. Leave empty otherwise.') || null;
      await unwrap(hr.POST('/api/v1/employees/{id}/documents', { params: { path: { id: employeeId } }, body: { document_type_id: typeId, document_id: doc.id, expiry_date: expiry } }));
      reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card>
      <h3 className="mb-3 font-semibold">Document checklist</h3>
      <ProblemBanner error={error} />
      {!checklist ? <Loading /> : (
        <table className="data">
          <thead><tr><th>Document</th><th>Required</th><th>State</th><th /></tr></thead>
          <tbody>
            {checklist.map((c) => (
              <tr key={c.document_type_id}>
                <td>{c.name}</td>
                <td>{c.required ? 'Yes' : ''}</td>
                <td><Badge value={c.state} /></td>
                <td className="flex flex-wrap gap-2">
                  {canEdit && <label className="cursor-pointer text-sm text-brand-600 underline">Upload<input type="file" className="sr-only" onChange={(x) => x.target.files?.[0] && upload(c.document_type_id, x.target.files[0])} /></label>}
                  {canVerify && c.employee_document_id && c.state === 'pending' && (
                    <>
                      <Button variant="ghost" onClick={() => unwrap(hr.POST('/api/v1/employees/{id}/documents/{rid}/verification', { params: { path: { id: employeeId, rid: c.employee_document_id! } }, body: { verification: 'verified' } })).then(reload, setError)}>Verify</Button>
                      <Button variant="ghost" onClick={() => unwrap(hr.POST('/api/v1/employees/{id}/documents/{rid}/verification', { params: { path: { id: employeeId, rid: c.employee_document_id! } }, body: { verification: 'rejected' } })).then(reload, setError)}>Reject</Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function LicencesTab({ employeeId, rows, canManage, canVerify, reload }: { employeeId: string; rows?: { id: string; licensing_body: string; licence_number: string; expiry_date: string; status: string; version: number }[]; canManage: boolean; canVerify: boolean; reload: () => void }) {
  const { settings } = useSession();
  const [form, setForm] = useState<{ licensing_body: string; licence_number: string; expiry_date: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">Professional licences</h3>
        {canManage && <Button variant="secondary" onClick={() => setForm({ licensing_body: '', licence_number: '', expiry_date: '' })}>Add licence</Button>}
      </div>
      <ProblemBanner error={error} />
      {!rows ? <Loading /> : !rows.length ? <Empty>No licences recorded.</Empty> : (
        <table className="data">
          <thead><tr><th>Body</th><th>Number</th><th>Expires</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.licensing_body}</td><td className="font-mono text-xs">{r.licence_number}</td><td>{formatDate(r.expiry_date, settings.date_format)}</td><td><Badge value={r.status} /></td>
                <td className="flex gap-2">
                  {canVerify && r.status === 'not_verified' && <Button variant="ghost" onClick={() => unwrap(hr.POST('/api/v1/licences/{id}/verification', { params: { path: { id: r.id } } })).then(reload, setError)}>Verify</Button>}
                  {canManage && <Button variant="ghost" onClick={() => { const d = window.prompt('New expiry date (YYYY-MM-DD)'); if (d) unwrap(hr.PATCH('/api/v1/licences/{id}', { params: { path: { id: r.id }, header: { 'If-Match': `"${r.version}"` } }, body: { expiry_date: d } })).then(reload, setError); }}>Renew</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form && (
        <Dialog open title="Add licence" onClose={() => setForm(null)}>
          <div className="space-y-3">
            <Field label="Licensing body" htmlFor="l-body" hint="e.g. NCK, KMPDC, PPB, KMLTTB"><Input id="l-body" value={form.licensing_body} onChange={(x) => setForm({ ...form, licensing_body: x.target.value })} /></Field>
            <Field label="Licence number" htmlFor="l-num"><Input id="l-num" value={form.licence_number} onChange={(x) => setForm({ ...form, licence_number: x.target.value })} /></Field>
            <Field label="Expiry date" htmlFor="l-exp"><Input id="l-exp" type="date" value={form.expiry_date} onChange={(x) => setForm({ ...form, expiry_date: x.target.value })} /></Field>
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button onClick={() => unwrap(hr.POST('/api/v1/employees/{id}/licences', { params: { path: { id: employeeId } }, body: form })).then(() => { setForm(null); reload(); }, setError)}>Save</Button></div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

export default function EmployeeProfilePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Profile />
    </Suspense>
  );
}
