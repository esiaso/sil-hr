import type { DepartmentNode } from '@sil/hr-shared';
import { serverGet } from '@/lib/server-session';
import { DepartmentsManager } from './manager';

export const metadata = { title: 'Departments' };

function Tree({ nodes }: { nodes: DepartmentNode[] }) {
  return (
    <ul className="ml-4 border-l border-[var(--border)] pl-3">
      {nodes.map((n) => (
        <li key={n.id} className="py-0.5">
          <span className="font-medium">{n.name}</span> <span className="muted text-xs">{n.code}</span>
          {n.children.length > 0 && <Tree nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

/** Server-rendered org tree (read-heavy), with the client-side manager below it. */
export default async function DepartmentsPage() {
  const tree = await serverGet<DepartmentNode[]>('/api/v1/departments/tree');
  return (
    <div className="space-y-6">
      <DepartmentsManager />
      <details className="surface rounded-xl p-4" open>
        <summary className="cursor-pointer font-medium">Organisation tree</summary>
        <div className="mt-3 text-sm">{tree.ok ? <Tree nodes={tree.data} /> : <p className="muted">Could not load the tree ({tree.problem.detail ?? tree.status}).</p>}</div>
      </details>
    </div>
  );
}
