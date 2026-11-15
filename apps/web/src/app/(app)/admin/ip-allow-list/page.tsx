'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

export default function IpAllowListPage() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['ip-rules'], queryFn: () => unwrap(hr.GET('/api/v1/ip-allow-rules')) });
  const [cidr, setCidr] = useState('');
  const [description, setDescription] = useState('');
  const [appliesTo, setAppliesTo] = useState<'all' | 'admin'>('all');
  const add = useMutation({
    mutationFn: () => unwrap(hr.POST('/api/v1/ip-allow-rules', { body: { cidr, description: description || null, applies_to: appliesTo } })),
    onSuccess: () => {
      setCidr('');
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['ip-rules'] });
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => unwrap(hr.DELETE('/api/v1/ip-allow-rules/{id}', { params: { path: { id } } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['ip-rules'] }) });
  return (
    <div className="max-w-3xl">
      <PageHeader title="IP allow-list" description="When enforcement is on (Settings → security.ip_allow_list_enabled), sign-in is only accepted from these networks. 'Administrators only' rules bind System Admins and nobody else." />
      <p className="muted mb-4 text-sm">Turn enforcement on or off in <Link className="underline" href="/admin/settings">Settings</Link>. Add your own network first, or you may lock yourself out.</p>
      <ProblemBanner error={add.error ?? remove.error ?? rules.error} />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <Field label="Address or CIDR block" htmlFor="cidr"><Input id="cidr" placeholder="196.201.0.0/16" value={cidr} onChange={(e) => setCidr(e.target.value)} /></Field>
          <Field label="Description" htmlFor="desc"><Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="Applies to" htmlFor="applies">
            <Select id="applies" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as 'all' | 'admin')}><option value="all">Everyone</option><option value="admin">Administrators only</option></Select>
          </Field>
          <Button busy={add.isPending} disabled={!cidr} onClick={() => add.mutate()}>Add</Button>
        </div>
      </Card>
      {!rules.data ? <Loading /> : (
        <div className="surface rounded-xl">
          <table className="data">
            <thead><tr><th>Network</th><th>Description</th><th>Applies to</th><th /></tr></thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono">{r.cidr}</td><td>{r.description}</td><td><Badge value={r.applies_to} /></td>
                  <td><Button variant="ghost" onClick={() => remove.mutate(r.id)}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
