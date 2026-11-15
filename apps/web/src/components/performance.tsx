'use client';

import Link from 'next/link';
import { REVIEW_STATUSES } from '@sil/hr-shared';
import { Badge, Empty } from '@/components/ui';

export interface ReviewRow {
  id: string;
  cycle_name: string;
  employee_name: string;
  staff_number: string;
  position_title: string | null;
  department_name: string | null;
  reviewer_name: string | null;
  status: keyof typeof REVIEW_STATUSES;
  self_rating: string | null;
  manager_rating: string | null;
  final_rating: string | null;
  band: string | null;
  goals: number;
}

/** A table of appraisals; each row opens the review. */
export function ReviewTable({ rows, showCycle, showReviewer = true }: { rows: ReviewRow[]; showCycle?: boolean; showReviewer?: boolean }) {
  if (!rows.length) return <Empty>No reviews.</Empty>;
  return (
    <table className="data">
      <thead><tr>{showCycle && <th>Cycle</th>}<th>Employee</th><th>Department</th>{showReviewer && <th>Reviewer</th>}<th>Goals</th><th>Self</th><th>Manager</th><th>Final</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          {showCycle && <td>{r.cycle_name}</td>}
          <td><Link className="link" href={`/performance/reviews/${r.id}`}>{r.employee_name}</Link> <span className="muted text-xs">{r.staff_number}</span></td>
          <td>{r.department_name}</td>
          {showReviewer && <td>{r.reviewer_name ?? <span className="text-amber-600">none</span>}</td>}
          <td>{r.goals}</td><td>{r.self_rating ?? '–'}</td><td>{r.manager_rating ?? '–'}</td>
          <td>{r.final_rating ? <span title={r.band ?? ''}>{r.final_rating}</span> : '–'}</td>
          <td><Badge value={REVIEW_STATUSES[r.status].toLowerCase()} /></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

/** 1–5 buttons. */
export function ScorePicker({ value, onChange, label, disabled }: { value: number | null; onChange: (n: number) => void; label: string; disabled?: boolean }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={disabled} aria-pressed={value === n} onClick={() => onChange(n)} className={`h-8 w-8 rounded-lg border text-sm disabled:opacity-60 ${value === n ? 'border-brand-500 bg-brand-500 text-white' : 'border-[var(--border)] hover:bg-[var(--hover)]'}`}>{n}</button>
      ))}
    </div>
  );
}
