'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { DATA_SCOPES, formatDateTime, type User } from '@sil/hr-shared';
import { Badge, Button, Dialog, Empty, Field, Input, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap, withEtag } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

type Assignment = { role_id: string; scope: string; branch_id?: string | null; department_id?: string | null };

function RolesEditor({ value, onChange }: { value: Assignment[]; onChange: (v: Assignment[]) => void }) {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => unwrap(hr.GET('/api/v1/roles')) });
  const l = useLookups();
  const set = (i: number, patch: Partial<Assignment>) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <div className="space-y-2">
      {value.map((a, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <Select aria-label="Role" value={a.role_id} onChange={(e) => set(i, { role_id: e.target.value })}>
            <option value="">Role…</option>
            {roles.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Data scope" value={a.scope} onChange={(e) => set(i, { scope: e.target.value, branch_id: null, department_id: null })}>
            {DATA_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </Select>
          {a.scope === 'branch' ? (
            <Select aria-label="Branch" value={a.branch_id ?? ''} onChange={(e) => set(i, { branch_id: e.target.value })}>
              <option value="">Branch…</option>
              {l.branchOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : a.scope === 'department' ? (
            <Select aria-label="Department" value={a.department_id ?? ''} onChange={(e) => set(i, { department_id: e.target.value })}>
              <option value="">Department…</option>
              {l.departmentOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <span />
          )}
          <Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove role">
            ×
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => onChange([...value, { role_id: '', scope: 'organisation' }])}>
        Add role
      </Button>
      <p className="muted text-xs">Scope limits what the role reaches: own record, direct reports, a department (and everything under it), a branch, or the whole organisation.</p>
    </div>
  );
}

const toInput = (a: Assignment) => ({ role_id: a.role_id, scope: a.scope as never, ...(a.scope === 'branch' ? { branch_id: a.branch_id } : {}), ...(a.scope === 'department' ? { department_id: a.department_id } : {}) });

function UserDialog({ userId, onClose }: { userId: string | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = userId === 'new';
  const existing = useQuery({ queryKey: ['user', userId], enabled: !isNew, queryFn: () => withEtag(hr.GET('/api/v1/users/{id}', { params: { path: { id: userId } } })) });
  const [form, setForm] = useState({ username: '', display_name: '', email: '', phone: '', password: '' });
  const [roles, setRoles] = useState<Assignment[]>([]);
  const [resetTo, setResetTo] = useState('');
  useEffect(() => {
    const u = existing.data?.data;
    if (u) {
      setForm({ username: u.username, display_name: u.display_name, email: u.email ?? '', phone: u.phone ?? '', password: '' });
      setRoles(u.roles.map((r) => ({ role_id: r.role_id, scope: r.scope, branch_id: r.branch_id, department_id: r.department_id })));
    }
  }, [existing.data]);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['user', userId] });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        await unwrap(hr.POST('/api/v1/users', { body: { username: form.username, display_name: form.display_name, email: form.email || null, phone: form.phone || null, password: form.password, roles: roles.map(toInput) } }));
      } else {
        await unwrap(hr.PATCH('/api/v1/users/{id}', { params: { path: { id: userId }, header: { 'If-Match': existing.data!.etag } }, body: { display_name: form.display_name, email: form.email || null, phone: form.phone || null } }));
        await unwrap(hr.PUT('/api/v1/users/{id}/roles', { params: { path: { id: userId } }, body: { roles: roles.map(toInput) } }));
      }
    },
    onSuccess: () => {
      done();
      onClose();
    },
  });
  const action = useMutation({
    mutationFn: async (what: 'disable' | 'enable' | 'unlock' | 'reset') => {
      if (what === 'unlock') return unwrap(hr.POST('/api/v1/users/{id}/unlock', { params: { path: { id: userId } } }));
      if (what === 'reset') return unwrap(hr.POST('/api/v1/users/{id}/password', { params: { path: { id: userId } }, body: { password: resetTo } }));
      return unwrap(hr.PATCH('/api/v1/users/{id}', { params: { path: { id: userId }, header: { 'If-Match': existing.data!.etag } }, body: { status: what === 'disable' ? 'disabled' : 'active' } }));
    },
    onSuccess: () => {
      setResetTo('');
      done();
      void existing.refetch();
    },
  });
  const u = existing.data?.data;
  return (
    <Dialog open wide title={isNew ? 'New user' : `User ${u?.username ?? ''}`} onClose={onClose}>
      {!isNew && !u ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <ProblemBanner error={save.error ?? action.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username" htmlFor="u-username">
              <Input id="u-username" value={form.username} disabled={!isNew} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </Field>
            <Field label="Display name" htmlFor="u-name">
              <Input id="u-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            </Field>
            <Field label="Email" htmlFor="u-email">
              <Input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Phone" htmlFor="u-phone">
              <Input id="u-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            {isNew && (
              <Field label="Initial password" htmlFor="u-pw" hint="They must change it at first sign-in">
                <Input id="u-pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Roles</h3>
            <RolesEditor value={roles} onChange={setRoles} />
          </div>
          {!isNew && u && (
            <div className="space-y-2 border-t border-[var(--border)] pt-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                Status: <Badge value={u.status} /> {u.mfa_enabled && <Badge value="2FA on" />}
                {u.status === 'locked' && (
                  <Button variant="secondary" onClick={() => action.mutate('unlock')}>
                    Unlock
                  </Button>
                )}
                {u.status === 'disabled' ? (
                  <Button variant="secondary" onClick={() => action.mutate('enable')}>
                    Enable
                  </Button>
                ) : (
                  <Button variant="danger" onClick={() => action.mutate('disable')}>
                    Disable
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Set a new password" htmlFor="u-reset">
                  <Input id="u-reset" type="password" autoComplete="new-password" value={resetTo} onChange={(e) => setResetTo(e.target.value)} />
                </Field>
                <Button variant="secondary" disabled={!resetTo} onClick={() => action.mutate('reset')}>
                  Reset password
                </Button>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button busy={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export default function UsersPage() {
  const { can, settings } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['users', search, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/users', { params: { query: { limit: 50, cursor: pageParam, search: search || undefined, status: (status || undefined) as User['status'] | undefined } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  return (
    <div>
      <PageHeader title="Users" description="Accounts that sign in. Users are not employees: many staff never log in, and some accounts (auditors) are not staff." actions={can('user:manage') && <Button onClick={() => setOpen('new')}>New user</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-40">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="locked">Locked</option>
        </Select>
      </div>
      <ProblemBanner error={q.error} />
      <div className="surface overflow-x-auto rounded-lg">
        {q.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <Empty>No users match.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Username</th>
                <th>Name</th>
                <th>Roles</th>
                <th>Status</th>
                <th>Last sign-in</th>
                {can('user:manage') && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="font-mono text-xs">{u.username}</td>
                  <td>{u.display_name}</td>
                  <td className="text-xs">{u.roles.map((r) => `${r.name} (${r.scope.replace('_', ' ')})`).join(', ')}</td>
                  <td>
                    <Badge value={u.status} />
                  </td>
                  <td className="text-xs">{formatDateTime(u.last_login_at, settings.timezone, settings.date_format)}</td>
                  {can('user:manage') && (
                    <td>
                      <Button variant="ghost" onClick={() => setOpen(u.id)}>
                        Edit
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <LoadMore hasMore={!!q.hasNextPage} busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
      {open && <UserDialog userId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
