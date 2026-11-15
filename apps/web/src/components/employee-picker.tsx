'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Input } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

/** Search-as-you-type for one employee. Shows the chosen person; "Change" searches again. */
export function EmployeePicker({ value, onChange, id = 'emp-pick' }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void; id?: string }) {
  const [q, setQ] = useState('');
  const found = useQuery({ queryKey: ['emp-pick', q], enabled: q.trim().length >= 2, queryFn: () => unwrap(hr.GET('/api/v1/employees', { params: { query: { limit: 15, search: q } } })) });
  if (value) return <div className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-sm"><span>{value.name}</span><button type="button" className="link text-xs" onClick={() => onChange(null)}>Change</button></div>;
  return (
    <div className="relative">
      <Input id={id} placeholder="Name or staff number" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {q.trim().length >= 2 && found.data && (
        <ul className="surface absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg text-sm shadow-lg">
          {!found.data.data.length && <li className="muted px-3 py-2">No one matches.</li>}
          {found.data.data.map((e) => <li key={e.id}><button type="button" className="w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]" onClick={() => { onChange({ id: e.id, name: `${e.first_name} ${e.last_name}` }); setQ(''); }}>{e.first_name} {e.last_name} <span className="muted">{e.staff_number}</span></button></li>)}
        </ul>
      )}
    </div>
  );
}
