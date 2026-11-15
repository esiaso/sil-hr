'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, formatMoney, MEDICAL_APPLICATION_KINDS } from '@sil/hr-shared';
import { RELATIONSHIP } from '@/components/medical';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function MembersPage() {
  const { can, settings } = useSession();
  const [tab, setTab] = useState<'members' | 'applications'>('members');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'active' | 'ended' | ''>('active');
  const [appStatus, setAppStatus] = useState<'pending' | ''>('pending');
  const [adjust, setAdjust] = useState<{ id: string; name: string } | null>(null);
  const members = useQuery({ queryKey: ['med-members', search, status], queryFn: () => unwrap(hr.GET('/api/v1/medical/members', { params: { query: { search: search || undefined, status: status || undefined } } })) });
  const apps = useQuery({ queryKey: ['med-apps', appStatus], queryFn: () => unwrap(hr.GET('/api/v1/medical/applications', { params: { query: { status: appStatus || undefined } } })) });
  return (
    <div className="space-y-4">
      <PageHeader title="Members and applications" description="Everyone covered, and applications to join, add or remove dependants, top up, pre-authorise or pay over the limit. Decisions are made in Approvals." actions={<Link href="/approvals"><Button variant="secondary">Open approvals</Button></Link>} />
      <div className="flex gap-1 border-b border-[var(--border)]">
        {(['members', 'applications'] as const).map((t) => <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? 'border-[var(--accent)] font-medium' : 'border-transparent muted'}`}>{t}</button>)}
      </div>
      {tab === 'members' ? (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <Input aria-label="Search" placeholder="Name, staff or member number" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as 'active')} className="max-w-36"><option value="active">Covered</option><option value="ended">Ended</option><option value="">All</option></Select>
          </div>
          <ProblemBanner error={members.error} />
          {!members.data ? <Loading /> : !members.data.length ? <Empty>No members.</Empty> : (
            <table className="data">
              <thead><tr><th>Member number</th><th>Name</th><th>Relationship</th><th>Staff</th><th>Scheme</th><th>Cover</th><th /></tr></thead>
              <tbody>{members.data.map((m) => (
                <tr key={m.id}><td className="font-mono text-xs">{m.member_number}</td><td>{m.name}</td><td>{RELATIONSHIP[m.relationship]}</td><td>{m.staff_number}</td><td>{m.scheme_name}</td>
                  <td className="text-xs">{formatDate(m.cover_start, settings.date_format)}{m.cover_end ? ` to ${formatDate(m.cover_end, settings.date_format)}` : ''} <Badge value={m.status} /></td>
                  <td className="text-right">{can('medical_setup:manage') && m.status === 'active' && <Button variant="ghost" onClick={() => setAdjust({ id: m.id, name: m.name })}>Adjust</Button>}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      ) : (
        <Card>
          <Select aria-label="Status" value={appStatus} onChange={(e) => setAppStatus(e.target.value as 'pending')} className="mb-3 max-w-40"><option value="pending">Waiting</option><option value="">All</option></Select>
          {!apps.data ? <Loading /> : !apps.data.length ? <Empty>Nothing waiting.</Empty> : (
            <table className="data">
              <thead><tr><th>Number</th><th>Staff member</th><th>What</th><th>For</th><th className="text-right">Amount</th><th>Sent</th><th>Status</th></tr></thead>
              <tbody>{apps.data.map((a) => <tr key={a.id}><td className="font-mono text-xs">{a.number}</td><td>{a.employee_name}</td><td>{MEDICAL_APPLICATION_KINDS[a.kind]}{a.category_name ? ` · ${a.category_name}` : ''}</td><td>{a.member_name}</td><td className="text-right tabular-nums">{a.amount ? formatMoney(a.amount, '') : ''}</td><td>{formatDate(a.created_at.slice(0, 10), settings.date_format)}</td><td><Badge value={a.status} /></td></tr>)}</tbody>
            </table>
          )}
        </Card>
      )}
      {adjust && <AdjustDialog member={adjust} onClose={() => setAdjust(null)} />}
    </div>
  );
}

function AdjustDialog({ member, onClose }: { member: { id: string; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const cover = useQuery({ queryKey: ['med-cover', member.id], queryFn: () => unwrap(hr.GET('/api/v1/medical/members/{id}/cover', { params: { path: { id: member.id } } })) });
  const [v, setV] = useState({ category_id: '', amount: '', reason: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/medical/members/{id}/adjustments', { params: { path: { id: member.id } }, body: { category_id: v.category_id || cover.data!.balances[0].category_id, amount: Number(v.amount).toFixed(2), reason: v.reason } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['med-cover'] }); onClose(); } });
  return (
    <Dialog open title={`Adjust ${member.name}'s usage`} onClose={onClose}>
      <ProblemBanner error={save.error ?? cover.error} />
      {!cover.data ? <Loading /> : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cover" htmlFor="ad-c"><Select id="ad-c" value={v.category_id} onChange={(e) => setV({ ...v, category_id: e.target.value })}>{cover.data.balances.map((b) => <option key={b.category_id} value={b.category_id}>{b.category_name} ({formatMoney(b.remaining, '')} left)</option>)}</Select></Field>
            <Field label="Amount" htmlFor="ad-a" hint="Positive uses limit; negative gives it back"><Input id="ad-a" type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
          </div>
          <Field label="Reason" htmlFor="ad-r"><Input id="ad-r" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!v.amount || v.reason.length < 3} onClick={() => save.mutate()}>Record</Button></div>
        </div>
      )}
    </Dialog>
  );
}
