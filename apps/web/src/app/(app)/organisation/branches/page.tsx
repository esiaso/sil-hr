'use client';

import { createBranch, updateBranch, type Branch } from '@sil/hr-shared';
import { ResourcePage } from '@/components/resource-page';
import { STATUS_OPTIONS } from '@/lib/lookups';

export default function BranchesPage() {
  return (
    <ResourcePage<Branch>
      config={{
        title: 'Branches',
        description: 'Sites of the organisation: the main hospital and satellite clinics. Departments belong to a branch.',
        path: 'branches',
        managePermission: 'branch:manage',
        columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'city', label: 'Town' }, { key: 'phone', label: 'Phone' }, { key: 'status', label: 'Status' }],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          { name: 'address', label: 'Address', type: 'textarea' },
          { name: 'city', label: 'Town / city' },
          { name: 'county', label: 'County' },
          { name: 'phone', label: 'Phone' },
          { name: 'email', label: 'Email', type: 'email' },
          { name: 'timezone', label: 'Timezone', hint: 'Leave blank to use the organisation timezone' },
          { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, editOnly: true },
        ],
        createSchema: createBranch,
        updateSchema: updateBranch,
        toForm: (b) => ({ code: b.code, name: b.name, address: b.address ?? '', city: b.city ?? '', county: b.county ?? '', phone: b.phone ?? '', email: b.email ?? '', timezone: b.timezone ?? '', status: b.status }),
      }}
    />
  );
}
