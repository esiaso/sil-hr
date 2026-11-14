'use client';

import { createPosition, updatePosition, type Position } from '@sil/hr-shared';
import { ResourcePage } from '@/components/resource-page';
import { STATUS_OPTIONS, useLookups } from '@/lib/lookups';

export default function PositionsPage() {
  const l = useLookups();
  return (
    <ResourcePage<Position>
      config={{
        title: 'Positions',
        description: 'Designations with their approved headcount and reporting line. The org chart and approval routing derive from these once staff are assigned (next slice).',
        path: 'positions',
        managePermission: 'position:manage',
        columns: [
          { key: 'code', label: 'Code' },
          { key: 'title', label: 'Title' },
          { key: 'department_id', label: 'Department', render: (p) => l.departments.get(p.department_id)?.name ?? '' },
          { key: 'job_grade_id', label: 'Grade', render: (p) => (p.job_grade_id ? l.grades.get(p.job_grade_id)?.code : '') },
          { key: 'reports_to_position_id', label: 'Reports to', render: (p) => (p.reports_to_position_id ? l.positions.get(p.reports_to_position_id)?.title : '') },
          { key: 'headcount', label: 'Headcount' },
          { key: 'licence_required', label: 'Licence' },
          { key: 'status', label: 'Status' },
        ],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'title', label: 'Title' },
          { name: 'department_id', label: 'Department', type: 'select', options: l.departmentOptions },
          { name: 'job_grade_id', label: 'Grade', type: 'select', options: l.gradeOptions },
          { name: 'reports_to_position_id', label: 'Reports to', type: 'select', options: l.positionOptions },
          { name: 'headcount', label: 'Approved headcount', type: 'number' },
          { name: 'is_clinical', label: 'Clinical position', type: 'checkbox' },
          { name: 'licence_required', label: 'Licensing body required', hint: 'e.g. NCK, KMPDC, PPB, KMLTTB' },
          { name: 'description', label: 'Description', type: 'textarea' },
          { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, editOnly: true },
        ],
        createSchema: createPosition,
        updateSchema: updatePosition,
        toForm: (p) => ({ code: p.code, title: p.title, department_id: p.department_id, job_grade_id: p.job_grade_id ?? '', reports_to_position_id: p.reports_to_position_id ?? '', headcount: p.headcount, is_clinical: p.is_clinical, licence_required: p.licence_required ?? '', description: p.description ?? '', status: p.status }),
      }}
    />
  );
}
