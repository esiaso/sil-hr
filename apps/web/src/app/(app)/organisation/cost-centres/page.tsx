'use client';

import { createCostCentre, updateCostCentre, type CostCentre } from '@sil/hr-shared';
import { ResourcePage } from '@/components/resource-page';
import { STATUS_OPTIONS } from '@/lib/lookups';

export default function CostCentresPage() {
  return (
    <ResourcePage<CostCentre>
      config={{
        title: 'Cost centres',
        description: 'Where staff costs are charged. HR owns membership (which department, and so which staff, charge to which cost centre); finance owns the chart of accounts they map to.',
        path: 'cost-centres',
        managePermission: 'cost_centre:manage',
        defaultSort: 'code',
        columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'description', label: 'Description' }, { key: 'status', label: 'Status' }],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          { name: 'description', label: 'Description', type: 'textarea' },
          { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, editOnly: true },
        ],
        createSchema: createCostCentre,
        updateSchema: updateCostCentre,
        toForm: (c) => ({ code: c.code, name: c.name, description: c.description ?? '', status: c.status }),
      }}
    />
  );
}
