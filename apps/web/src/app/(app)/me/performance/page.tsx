'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { ReviewTable } from '@/components/performance';
import { hr, unwrap } from '@/lib/api';

export default function MyPerformancePage() {
  const mine = useQuery({ queryKey: ['my-reviews'], queryFn: () => unwrap(hr.GET('/api/v1/me/reviews')) });
  const team = useQuery({ queryKey: ['team-reviews'], queryFn: () => unwrap(hr.GET('/api/v1/me/team-reviews')) });
  return (
    <div className="space-y-4">
      <PageHeader title="My performance" description="Your appraisals: agree goals with your reviewer, keep progress up to date, score yourself, then read and acknowledge the approved review." />
      <ProblemBanner error={mine.error ?? team.error} />
      <Card><h2 className="mb-2 font-semibold">My appraisals</h2>{!mine.data ? <Loading /> : <ReviewTable rows={mine.data} showCycle />}</Card>
      {!!team.data?.length && <Card><h2 className="mb-2 font-semibold">Appraisals I write</h2><ReviewTable rows={team.data} showCycle showReviewer={false} /></Card>}
    </div>
  );
}
