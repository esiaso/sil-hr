'use client';

import { createJobGrade, updateJobGrade, type JobGrade } from '@sil/hr-shared';
import { ResourcePage } from '@/components/resource-page';
import { STATUS_OPTIONS } from '@/lib/lookups';

export default function JobGradesPage() {
  return (
    <ResourcePage<JobGrade>
      config={{
        title: 'Job grades',
        description: 'Grades rank positions (1 = most senior). Leave policies, salary structures and approval thresholds will refer to them.',
        path: 'job-grades',
        managePermission: 'job_grade:manage',
        defaultSort: 'rank',
        columns: [{ key: 'rank', label: 'Rank' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          { name: 'rank', label: 'Rank', type: 'number', hint: 'Lower is more senior' },
          { name: 'description', label: 'Description', type: 'textarea' },
          { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, editOnly: true },
        ],
        createSchema: createJobGrade,
        updateSchema: updateJobGrade,
        toForm: (g) => ({ code: g.code, name: g.name, rank: g.rank, description: g.description ?? '', status: g.status }),
      }}
    />
  );
}
