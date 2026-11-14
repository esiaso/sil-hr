'use client';

import { createDepartment, updateDepartment, type Department } from '@sil/hr-shared';
import { ResourcePage } from '@/components/resource-page';
import { STATUS_OPTIONS, useLookups } from '@/lib/lookups';

export function DepartmentsManager() {
  const l = useLookups();
  const pathOf = (d: Department) => [...d.path.map((id) => l.departments.get(id)?.name ?? '…'), d.name].join(' › ');
  return (
    <ResourcePage<Department>
      config={{
        title: 'Departments',
        description: 'Departments, sub-departments and units form a tree within a branch. Moving one moves everything under it; other systems are told through hr.organisation.department.updated.v1.',
        path: 'departments',
        managePermission: 'department:manage',
        columns: [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Department', render: pathOf },
          { key: 'branch_id', label: 'Branch', render: (d) => l.branches.get(d.branch_id)?.name ?? '' },
          { key: 'cost_centre_id', label: 'Cost centre', render: (d) => (d.cost_centre_id ? l.costCentres.get(d.cost_centre_id)?.code : '') },
          { key: 'status', label: 'Status' },
        ],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          { name: 'branch_id', label: 'Branch', type: 'select', options: l.branchOptions },
          { name: 'parent_id', label: 'Parent department', type: 'select', options: l.departmentOptions, hint: 'Leave empty for a top-level department' },
          { name: 'cost_centre_id', label: 'Cost centre', type: 'select', options: l.costCentreOptions },
          { name: 'description', label: 'Description', type: 'textarea' },
          { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, editOnly: true },
        ],
        createSchema: createDepartment,
        updateSchema: updateDepartment,
        toForm: (d) => ({ code: d.code, name: d.name, branch_id: d.branch_id, parent_id: d.parent_id ?? '', cost_centre_id: d.cost_centre_id ?? '', description: d.description ?? '', status: d.status }),
      }}
    />
  );
}
