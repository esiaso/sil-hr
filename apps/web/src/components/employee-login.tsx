'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Employee } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Field, Input, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * The employee's sign-in account: who it is, and (for user administrators) creating one,
 * linking an existing one, or unlinking. Linking is what makes My payslips, My leave and the
 * approvals of their reports work for that person.
 */
export function EmployeeLogin({ e, onChanged }: { e: Employee; onChanged: () => void }) {
  const { can } = useSession();
  const manage = can('user:manage') && can('employee:update');
  const [dialog, setDialog] = useState<'create' | 'link' | null>(null);
  const user = useQuery({ queryKey: ['user', e.user_id], enabled: !!e.user_id && can('user:read'), queryFn: () => unwrap(hr.GET('/api/v1/users/{id}', { params: { path: { id: e.user_id! } } })) });
  const unlink = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/employees/{id}/user', { params: { path: { id: e.id } }, body: { user_id: null } })), onSuccess: onChanged });
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Sign-in account</h3>
        {manage && e.status !== 'exited' && (
          <div className="flex gap-2">
            {!e.user_id && <><Button variant="secondary" onClick={() => setDialog('link')}>Link existing</Button><Button onClick={() => setDialog('create')}>Create login</Button></>}
            {e.user_id && <Button variant="ghost" busy={unlink.isPending} onClick={() => window.confirm('Unlink this account? The person keeps the login but loses access to their own records (payslips, leave) until it is linked again.') && unlink.mutate()}>Unlink</Button>}
          </div>
        )}
      </div>
      <ProblemBanner error={unlink.error ?? user.error} />
      {!e.user_id ? (
        <p className="muted text-sm">No login. Without one, this person cannot see their payslips, apply for leave or approve for their team.</p>
      ) : user.data ? (
        <dl className="text-sm">
          <div className="flex justify-between py-1"><dt className="muted">Username</dt><dd>{user.data.username}</dd></div>
          <div className="flex justify-between py-1"><dt className="muted">Display name</dt><dd>{user.data.display_name}</dd></div>
          <div className="flex justify-between py-1"><dt className="muted">Status</dt><dd><Badge value={user.data.status} /></dd></div>
          <div className="flex justify-between py-1"><dt className="muted">Roles</dt><dd className="text-right">{user.data.roles.map((r) => `${r.name} (${r.scope.replace('_', ' ')})`).join(', ') || '–'}</dd></div>
        </dl>
      ) : (
        <p className="text-sm">Linked to a sign-in account.</p>
      )}
      {dialog === 'create' && <CreateLogin e={e} onClose={(done) => { setDialog(null); if (done) onChanged(); }} />}
      {dialog === 'link' && <LinkLogin e={e} onClose={(done) => { setDialog(null); if (done) onChanged(); }} />}
    </Card>
  );
}

function CreateLogin({ e, onClose }: { e: Employee; onClose: (done: boolean) => void }) {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => unwrap(hr.GET('/api/v1/roles')) });
  const suggested = (e.work_email?.split('@')[0] ?? `${e.first_name}.${e.last_name}`).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const [f, setF] = useState({ username: suggested, password: '' });
  const employeeRole = roles.data?.find((r) => r.code === 'employee');
  const save = useMutation({
    mutationFn: async () => {
      const roleId = employeeRole?.id;
      const u = await unwrap(hr.POST('/api/v1/users', { body: { username: f.username, display_name: e.display_name, email: e.work_email, phone: e.work_phone, password: f.password, roles: roleId ? [{ role_id: roleId, scope: 'own' }] : [] } }));
      await unwrap(hr.PUT('/api/v1/employees/{id}/user', { params: { path: { id: e.id } }, body: { user_id: u.id } }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); onClose(true); },
  });
  return (
    <Dialog open title={`Create a login for ${e.display_name}`} onClose={() => onClose(false)}>
      <ProblemBanner error={save.error} />
      <div className="space-y-3">
        <Field label="Username" htmlFor="cl-u"><Input id="cl-u" value={f.username} onChange={(x) => setF({ ...f, username: x.target.value })} /></Field>
        <Field label="Temporary password" htmlFor="cl-p" hint="They must choose their own at first sign-in. Give it to them in person or by phone, not by email."><Input id="cl-p" type="password" autoComplete="new-password" value={f.password} onChange={(x) => setF({ ...f, password: x.target.value })} /></Field>
        <p className="muted text-xs">The login gets the Employee role (their own records). Give manager, HR or other roles under Administration → Users, with the right scope.</p>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button busy={save.isPending} disabled={!f.username || !f.password} onClick={() => save.mutate()}>Create and link</Button></div>
    </Dialog>
  );
}

function LinkLogin({ e, onClose }: { e: Employee; onClose: (done: boolean) => void }) {
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState('');
  const users = useQuery({ queryKey: ['users-link', search], enabled: search.trim().length >= 2, queryFn: () => unwrap(hr.GET('/api/v1/users', { params: { query: { limit: 20, search, status: 'active' } } })) });
  const free = (users.data?.data ?? []).filter((u) => !u.employee_id);
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/employees/{id}/user', { params: { path: { id: e.id } }, body: { user_id: pick } })), onSuccess: () => onClose(true) });
  return (
    <Dialog open title={`Link an existing login to ${e.display_name}`} onClose={() => onClose(false)}>
      <ProblemBanner error={save.error} />
      <Field label="Find the login" htmlFor="ll-s" hint="Username, name or email; logins already linked to someone are not shown"><Input id="ll-s" value={search} onChange={(x) => setSearch(x.target.value)} /></Field>
      {search.trim().length >= 2 && (
        <Field label="Login" htmlFor="ll-u"><Select id="ll-u" value={pick} onChange={(x) => setPick(x.target.value)}><option value="">{free.length ? 'Choose…' : 'No unlinked logins match'}</option>{free.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>)}</Select></Field>
      )}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button busy={save.isPending} disabled={!pick} onClick={() => save.mutate()}>Link</Button></div>
    </Dialog>
  );
}
