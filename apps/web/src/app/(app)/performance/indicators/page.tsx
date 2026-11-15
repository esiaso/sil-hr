'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { INDICATOR_CATEGORIES, MEASURES } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';

type Indicator = NonNullable<Awaited<ReturnType<typeof list>>>[number];
type Category = keyof typeof INDICATOR_CATEGORIES;
type Measure = keyof typeof MEASURES;
const list = () => unwrap(hr.GET('/api/v1/performance/indicators', { params: { query: {} } }));

export default function IndicatorsPage() {
  const q = useQuery({ queryKey: ['indicators', 'all'], queryFn: list });
  const [edit, setEdit] = useState<Indicator | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader title="Indicator library" description="Key performance indicators staff and reviewers can pick when setting goals." actions={<Button onClick={() => setEdit('new')}>New indicator</Button>} />
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No indicators.</Empty> : (
          <table className="data">
            <thead><tr><th>Code</th><th>Indicator</th><th>Category</th><th>Measure</th><th>Default target</th><th>Suggested for</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.map((i) => (
              <tr key={i.id}>
                <td className="font-mono text-xs">{i.code}</td><td><div className="font-medium">{i.name}</div>{i.description && <div className="muted text-xs">{i.description}</div>}</td>
                <td>{INDICATOR_CATEGORIES[i.category]}</td><td>{MEASURES[i.measure]}</td><td>{i.default_target}</td><td>{i.position_title ?? i.department_name ?? 'Anyone'}</td>
                <td><Badge value={i.status} /></td><td className="text-right"><button type="button" className="link text-sm" onClick={() => setEdit(i)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {edit && <IndicatorDialog i={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function IndicatorDialog({ i, onClose }: { i: Indicator | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { departmentOptions, positionOptions } = useLookups();
  const [f, setF] = useState({ code: i?.code ?? '', name: i?.name ?? '', description: i?.description ?? '', category: (i?.category ?? 'clinical') as Category, measure: (i?.measure ?? 'rating') as Measure, default_target: i?.default_target ?? '', department_id: i?.department_id ?? '', position_id: i?.position_id ?? '', status: i?.status ?? 'active' });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, description: f.description || null, default_target: f.default_target || null, department_id: f.department_id || null, position_id: f.position_id || null };
      return i ? unwrap(hr.PUT('/api/v1/performance/indicators/{id}', { params: { path: { id: i.id }, header: { 'If-Match': `"${i.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/performance/indicators', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['indicators'] }); onClose(); },
  });
  return (
    <Dialog open title={i ? `Edit ${i.code}` : 'New indicator'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" htmlFor="in-c"><Input id="in-c" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name" htmlFor="in-n"><Input id="in-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Category" htmlFor="in-cat"><Select id="in-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Category })}>{Object.entries(INDICATOR_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Measure" htmlFor="in-m"><Select id="in-m" value={f.measure} onChange={(e) => setF({ ...f, measure: e.target.value as Measure })}>{Object.entries(MEASURES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Default target" htmlFor="in-t"><Input id="in-t" value={f.default_target} onChange={(e) => setF({ ...f, default_target: e.target.value })} /></Field>
        <Field label="Status" htmlFor="in-s"><Select id="in-s" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'active' })}><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
        <Field label="Suggested for department" htmlFor="in-d"><Select id="in-d" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}><option value="">Any</option>{departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        <Field label="Suggested for position" htmlFor="in-p"><Select id="in-p" value={f.position_id} onChange={(e) => setF({ ...f, position_id: e.target.value })}><option value="">Any</option>{positionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
      </div>
      <Field label="How it is measured" htmlFor="in-de"><Textarea id="in-de" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}
