'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatMoney } from '@sil/hr-shared';
import { buttonClass, Card, Empty, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';

/** P9A tax deduction cards: one per employee per year, or every one at once as a ZIP of PDFs. */
export default function P9Page() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const { departmentOptions } = useLookups();
  const q = useQuery({ queryKey: ['p9-employees', year], queryFn: () => unwrap(hr.GET('/api/v1/payroll/p9/employees', { params: { query: { year } } })) });
  const rows = useMemo(() => (q.data ?? []).filter((r) => !search || `${r.employee_name} ${r.staff_number}`.toLowerCase().includes(search.toLowerCase())), [q.data, search]);
  const bulk = `/api/v1/payroll/p9/bulk?year=${year}${dept ? `&department_id=${dept}` : ''}`;
  return (
    <div className="space-y-4">
      <PageHeader
        title="P9 forms"
        description="KRA P9A tax deduction cards for each member of staff, from the year's approved payrolls. Staff can also download their own under My payslips."
        actions={<a className={buttonClass('primary')} href={bulk}>Download all{dept ? ' in the department' : ''} (ZIP)</a>}
      />
      <Card>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Year" className="w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))}>{[0, 1, 2, 3].map((d) => thisYear - d).map((y) => <option key={y} value={y}>{y}</option>)}</Select>
          <Select aria-label="Department for the ZIP" className="w-auto" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
          <Input aria-label="Search" placeholder="Name or staff number" className="max-w-xs" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </Card>
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !rows.length ? <Empty>No approved payslips in {year}{search ? ' for that search' : ''}.</Empty> : (
          <table className="data">
            <thead><tr><th>Staff no.</th><th>Name</th><th>Department</th><th className="text-right">Months</th><th className="text-right">PAYE for the year</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.employee_id}>
                <td>{r.staff_number}</td><td>{r.employee_name}</td><td>{r.department}</td><td className="text-right">{r.months}</td><td className="text-right tabular-nums">{formatMoney(r.paye)}</td>
                <td className="text-right"><a className="link text-sm" href={`/api/v1/payroll/p9?employee_id=${r.employee_id}&year=${year}`}>P9 (PDF)</a></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
