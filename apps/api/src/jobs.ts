import type { INestApplicationContext } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { loadEnv } from './config/env';
import { eventsPublished, rootLogger } from './common/logger';
import { createRedis } from './common/redis';
import { RequestContext } from './common/request-context';
import { BulkService } from './modules/employees/bulk';
import { EmployeesService } from './modules/employees/employees.service';
import { LicencesService } from './modules/employees/licences.service';
import { AttendanceService } from './modules/attendance/attendance.service';
import { ConnectorsService } from './modules/attendance/connectors.service';
import { LeaveService } from './modules/leave/leave.service';
import { WorkflowService } from './modules/workflow/workflow.service';
import { MedicalService } from './modules/medical/medical.service';
import { LifecycleService } from './modules/lifecycle/lifecycle.service';
import { NotificationsService } from './modules/notifications/notifications.module';
import { OutboxPublisher, WebhookDeliveryProcessor } from './modules/webhooks/publishing';

/**
 * Recurring background work. The work itself is database-driven and idempotent (outbox
 * rows, delivery rows with due times), so losing Redis loses no events or deliveries;
 * BullMQ only schedules and spreads the work across worker processes.
 */
export const JOBS: { name: string; everyMs: number; run: (app: INestApplicationContext) => Promise<number> }[] = [
  { name: 'outbox-publish', everyMs: 1000, run: async (app) => { const n = await app.get(OutboxPublisher).drainOnce(200); eventsPublished.inc(n); return n; } },
  { name: 'webhook-deliveries', everyMs: 2000, run: (app) => app.get(WebhookDeliveryProcessor).processDue(50) },
  { name: 'bulk-jobs', everyMs: 3000, run: (app) => app.get(BulkService).processQueued() },
  { name: 'workflow-escalations', everyMs: 300_000, run: (app) => app.get(WorkflowService).escalateDue() },
  { name: 'leave-accrual', everyMs: 3_600_000, run: (app) => app.get(LeaveService).accrueAll() },
  { name: 'leave-carry-forward', everyMs: 3_600_000, run: (app) => app.get(LeaveService).carryForwardAll() },
  { name: 'connector-pulls', everyMs: 60_000, run: (app) => app.get(ConnectorsService).runDue() },
  { name: 'attendance-recompute', everyMs: 6 * 3_600_000, run: (app) => app.get(AttendanceService).recomputeRecent() },
  { name: 'send-mail', everyMs: 10_000, run: (app) => app.get(NotificationsService).sendPendingMail(50) },
  // Daily work runs hourly: each is idempotent, so a missed hour or a restart costs nothing.
  { name: 'licence-sweep', everyMs: 3_600_000, run: async (app) => { const r = await app.get(LicencesService).sweep(); return r.expiring + r.expired; } },
  { name: 'apply-due-assignments', everyMs: 3_600_000, run: (app) => app.get(EmployeesService).applyDueAssignments() },
  { name: 'lifecycle-sweep', everyMs: 3_600_000, run: (app) => app.get(LifecycleService).sweep() },
  { name: 'medical-sweep', everyMs: 3_600_000, run: (app) => app.get(MedicalService).sweep() },
];

const QUEUE = 'silhr-scheduled';

function runJob(app: INestApplicationContext, name: string): Promise<number> {
  const job = JOBS.find((j) => j.name === name);
  if (!job) return Promise.resolve(0);
  return RequestContext.run({ actorType: 'system', actorName: `job:${name}` }, () => job.run(app));
}

/** Worker process: registers the repeatable jobs and processes them. */
export async function startQueueWorker(app: INestApplicationContext): Promise<() => Promise<void>> {
  const env = loadEnv();
  const queue = new Queue(QUEUE, { connection: createRedis(env.redisUrl) });
  for (const job of JOBS) {
    await queue.upsertJobScheduler(job.name, { every: job.everyMs }, { name: job.name, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }
  const worker = new Worker(QUEUE, async (job) => runJob(app, job.name), { connection: createRedis(env.redisUrl), concurrency: JOBS.length });
  worker.on('failed', (job, err) => rootLogger.error({ err, job: job?.name }, 'Job failed'));
  return async () => {
    await worker.close();
    await queue.close();
  };
}

/** Development / single-process mode: the same jobs on timers inside the API. */
export function startInlineJobs(app: INestApplicationContext): () => void {
  const timers = JOBS.map((job) => {
    let running = false;
    return setInterval(() => {
      if (running) return;
      running = true;
      runJob(app, job.name)
        .catch((err) => rootLogger.error({ err, job: job.name }, 'Job failed'))
        .finally(() => (running = false));
    }, job.everyMs);
  });
  return () => timers.forEach(clearInterval);
}
