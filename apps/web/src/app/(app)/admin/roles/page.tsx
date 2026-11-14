'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Role } from '@sil/hr-shared';
import { Badge, Button, Dialog, Field, Input, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

function RoleDialog({ role, onClose }: { role: Role | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const catalogue = useQuery({ queryKey: ['permissions'], queryFn: () => unwrap(hr.GET('/api/v1/permissions')) });
  const isNew = role === 'new';
  const [code, setCode] = useState(isNew ? '' : role.code);
  const [name, setName] = useState(isNew ? '' : role.name);
  const [description, setDescription] = useState(isNew ? '' : (role.description ?? ''));
  const [perms, setPerms] = useState<Set<string>>(new Set(isNew ? [] : role.permissions));
  const save = useMutation({
    mutationFn: () =>
      isNew
        ? unwrap(hr.POST('/api/v1/roles', { body: { code, name, description: description || null, permissions: [...perms] } }))
        : unwrap(hr.PATCH('/api/v1/roles/{id}', { params: { path: { id: role.id }, header: { 'If-Match': `"${role.version}"` } }, body: { name, description: description || null, permissions: [...perms] } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
  });
  const toggle = (c: string) => setPerms((p) => {
    const n = new Set(p);
    if (n.has(c)) n.delete(c);
    else n.add(c);
    return n;
  });
  return (
    <Dialog open wide title={isNew ? 'New role' : `Role: ${role.name}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" htmlFor="r-code" hint="lowercase_with_underscores">
          <Input id="r-code" value={code} disabled={!isNew} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Name" htmlFor="r-name">
          <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Description" htmlFor="r-desc">
          <Input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      {!catalogue.data ? (
        <Loading />
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {catalogue.data.groups.map((g) => (
            <fieldset key={g.label} className="text-sm">
              <legend className="mb-1 font-semibold">{g.label}</legend>
              {catalogue.data.permissions
                .filter((p) => g.prefixes.includes(p.code.split(':')[0]))
                .map((p) => (
                  <label key={p.code} className="flex items-start gap-2 py-0.5">
                    <input type="checkbox" className="mt-1" checked={perms.has(p.code)} onChange={() => toggle(p.code)} />
                    <span>
                      {p.description} <code className="muted text-xs">{p.code}</code>
                    </span>
                  </label>
                ))}
            </fieldset>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button busy={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}

export default function RolesPage() {
  const { can } = useSession();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => unwrap(hr.GET('/api/v1/roles')) });
  const [open, setOpen] = useState<Role | 'new' | null>(null);
  return (
    <div>
      <PageHeader title="Roles & permissions" description="Roles are sets of permissions. Where a role applies (own record, department, branch, organisation) is chosen when it is given to a user." actions={can('role:manage') && <Button onClick={() => setOpen('new')}>New role</Button>} />
      <ProblemBanner error={roles.error} />
      {!roles.data ? (
        <Loading />
      ) : (
        <div className="surface overflow-x-auto rounded-lg">
          <table className="data">
            <thead>
              <tr>
                <th>Role</th>
                <th>Description</th>
                <th>Permissions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name} {r.is_system && <Badge value="built-in" />}
                    <div className="muted font-mono text-xs">{r.code}</div>
                  </td>
                  <td className="text-sm">{r.description}</td>
                  <td>{r.permissions.length}</td>
                  <td>
                    {can('role:manage') && (
                      <Button variant="ghost" onClick={() => setOpen(r)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <RoleDialog role={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
