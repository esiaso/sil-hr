'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Setting } from '@sil/hr-shared';
import { Button, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

function SettingRow({ s, canEdit }: { s: Setting; canEdit: boolean }) {
  const qc = useQueryClient();
  const initial = s.type === 'json' ? JSON.stringify(s.value) : String(s.value);
  const [value, setValue] = useState(initial);
  const save = useMutation({
    mutationFn: () => {
      const parsed = s.type === 'number' ? Number(value) : s.type === 'boolean' ? value === 'true' : s.type === 'json' ? JSON.parse(value) : value;
      return unwrap(hr.PUT('/api/v1/settings/{key}', { params: { path: { key: s.key } }, body: { value: parsed } }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  return (
    <tr>
      <td>
        <code className="text-xs">{s.key}</code>
        <div className="muted text-xs">{s.description}</div>
        {save.error && <div className="text-xs text-red-600">{(save.error as Error).message}</div>}
      </td>
      <td className="w-72">
        {s.type === 'boolean' ? (
          <Select aria-label={s.key} value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)}><option value="true">Yes</option><option value="false">No</option></Select>
        ) : (
          <Input aria-label={s.key} value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)} />
        )}
      </td>
      <td className="w-20">{canEdit && value !== initial && <Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}</td>
    </tr>
  );
}

export default function SettingsPage() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(hr.GET('/api/v1/settings')) });
  return (
    <div>
      <PageHeader title="Settings" description="Business configuration lives here, not in code: currency, timezone, date format, working week, leave year, password policy, webhook retries. Changes are audited." />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : (
        <div className="surface overflow-x-auto rounded-xl">
          <table className="data"><tbody>{q.data.map((s) => <SettingRow key={`${s.key}:${JSON.stringify(s.value)}`} s={s} canEdit={can('setting:manage')} />)}</tbody></table>
        </div>
      )}
    </div>
  );
}
