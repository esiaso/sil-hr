'use client';

import { useQuery } from '@tanstack/react-query';
import { hr, unwrap } from './api';

/** Small reference lists for selects (organisation structure is at most a few hundred rows). */
export function useLookups() {
  const branches = useQuery({ queryKey: ['lookup', 'branches'], queryFn: () => unwrap(hr.GET('/api/v1/branches', { params: { query: { limit: 500 } } })) });
  const departments = useQuery({ queryKey: ['lookup', 'departments'], queryFn: () => unwrap(hr.GET('/api/v1/departments', { params: { query: { limit: 500 } } })) });
  const costCentres = useQuery({ queryKey: ['lookup', 'cost-centres'], queryFn: () => unwrap(hr.GET('/api/v1/cost-centres', { params: { query: { limit: 500 } } })) });
  const grades = useQuery({ queryKey: ['lookup', 'job-grades'], queryFn: () => unwrap(hr.GET('/api/v1/job-grades', { params: { query: { limit: 500 } } })) });
  const positions = useQuery({ queryKey: ['lookup', 'positions'], queryFn: () => unwrap(hr.GET('/api/v1/positions', { params: { query: { limit: 500 } } })) });
  const opts = <T extends { id: string }>(rows: T[] | undefined, label: (r: T) => string) => (rows ?? []).map((r) => ({ value: r.id, label: label(r) }));
  const byId = <T extends { id: string }>(rows: T[] | undefined) => new Map((rows ?? []).map((r) => [r.id, r]));
  return {
    branchOptions: opts(branches.data?.data, (b) => b.name),
    departmentOptions: opts(departments.data?.data, (d) => `${d.name} (${d.code})`),
    costCentreOptions: opts(costCentres.data?.data, (c) => `${c.code} · ${c.name}`),
    gradeOptions: opts(grades.data?.data, (g) => `${g.code} · ${g.name}`),
    positionOptions: opts(positions.data?.data, (p) => `${p.title} (${p.code})`),
    branches: byId(branches.data?.data),
    departments: byId(departments.data?.data),
    costCentres: byId(costCentres.data?.data),
    grades: byId(grades.data?.data),
    positions: byId(positions.data?.data),
  };
}

export const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];
