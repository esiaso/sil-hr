import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import { acknowledgeReview, calibrate, createCycle, goalProgress, managerReview, ratingBand, selfReview, upsertGoal, upsertIndicator } from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { OutboxService } from '../events/events.module';
import { NotificationsService } from '../notifications/notifications.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { PerformanceGoal, PerformanceIndicator, PerformanceReview, ReviewCycle } from './performance.entities';

type Dto<T extends z.ZodType> = z.infer<T>;
const r2 = (x: Decimal.Value | null) => (x === null ? null : new Decimal(x).toFixed(2));

/** Weighted mean of the scores of agreed goals, or null while any is missing. */
export function weightedRating(goals: { weight: number; score: number | null }[]): string | null {
  if (!goals.length || goals.some((g) => g.score === null)) return null;
  const w = goals.reduce((s, g) => s + g.weight, 0);
  if (!w) return null;
  return goals.reduce((s, g) => s.plus(new Decimal(g.score!).mul(g.weight)), new Decimal(0)).div(w).toFixed(2);
}

interface ReviewRow {
  employee_name: string;
  staff_number: string;
  position_title: string | null;
  department_name: string | null;
  branch_id: string | null;
  department_id: string | null;
  reviewer_name: string | null;
}

@Injectable()
export class PerformanceService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly scope: ScopeService,
  ) {}

  onModuleInit(): void {
    this.workflow.registerHandler('performance_review', {
      onApproved: (m, i) => this.reviewApproved(m, i),
      onRejected: (m, i, c) => this.reviewSentBack(m, i, c),
      onReturned: (m, i, c) => this.reviewSentBack(m, i, c),
    });
  }

  // ================================================================== indicators
  private async indicatorDto(m: EntityManager, i: PerformanceIndicator) {
    const [x] = await m.query(`SELECT (SELECT name FROM department WHERE id = $1) AS dept, (SELECT title FROM position WHERE id = $2) AS pos`, [i.departmentId, i.positionId]);
    return {
      id: i.id, code: i.code, name: i.name, description: i.description, category: i.category as 'clinical', measure: i.measure, default_target: i.defaultTarget, department_id: i.departmentId, department_name: x?.dept ?? null,
      position_id: i.positionId, position_title: x?.pos ?? null, status: i.status, created_at: i.createdAt.toISOString(), updated_at: i.updatedAt.toISOString(), version: i.version,
    };
  }

  async indicators(q: { status?: string }) {
    const m = this.dataSource.manager;
    const rows = await m.getRepository(PerformanceIndicator).find({ where: q.status ? { status: q.status as 'active' } : {}, order: { category: 'ASC', name: 'ASC' } });
    return Promise.all(rows.map((i) => this.indicatorDto(m, i)));
  }

  async saveIndicator(dto: Dto<typeof upsertIndicator>, id?: string, version?: number) {
    const m = this.dataSource.manager;
    const repo = m.getRepository(PerformanceIndicator);
    const i = id ? await repo.findOneBy({ id }) : repo.create();
    if (!i) throw notFound('Indicator');
    if (id && version !== undefined) assertVersion(i.version, version);
    const clash = await repo.findOneBy({ code: dto.code });
    if (clash && clash.id !== i.id) throw conflict('duplicate_code', `Indicator ${dto.code} already exists`);
    Object.assign(i, { code: dto.code, name: dto.name, description: dto.description ?? null, category: dto.category, measure: dto.measure, defaultTarget: dto.default_target ?? null, departmentId: dto.department_id ?? null, positionId: dto.position_id ?? null, status: dto.status });
    return this.indicatorDto(m, await repo.save(i));
  }

  // ================================================================== cycles
  private async cycleDto(m: EntityManager, c: ReviewCycle) {
    const [x] = await m.query(
      `SELECT (SELECT name FROM department WHERE id = $2) AS dept,
              count(r.id)::int AS reviews,
              count(r.id) FILTER (WHERE EXISTS (SELECT 1 FROM performance_goal g WHERE g.review_id = r.id AND g.status = 'agreed'))::int AS goals_agreed,
              count(r.id) FILTER (WHERE r.self_submitted_at IS NOT NULL)::int AS self_done,
              count(r.id) FILTER (WHERE r.manager_submitted_at IS NOT NULL)::int AS manager_done,
              count(r.id) FILTER (WHERE r.status = 'completed')::int AS completed
         FROM performance_review r WHERE r.cycle_id = $1`,
      [c.id, c.departmentId],
    );
    return {
      id: c.id, name: c.name, kind: c.kind, period_start: c.periodStart, period_end: c.periodEnd, goals_due: c.goalsDue, self_review_due: c.selfReviewDue, manager_review_due: c.managerReviewDue,
      department_id: c.departmentId, department_name: x?.dept ?? null, status: c.status, launched_at: c.launchedAt?.toISOString() ?? null,
      counts: { reviews: x.reviews, goals_agreed: x.goals_agreed, self_done: x.self_done, manager_done: x.manager_done, completed: x.completed },
      created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(), version: c.version,
    };
  }

  async cycles() {
    const m = this.dataSource.manager;
    const rows = await m.getRepository(ReviewCycle).find({ order: { periodStart: 'DESC', createdAt: 'DESC' }, take: 100 });
    return Promise.all(rows.map((c) => this.cycleDto(m, c)));
  }

  async cycle(id: string) {
    const c = await this.dataSource.getRepository(ReviewCycle).findOneBy({ id });
    if (!c) throw notFound('Review cycle');
    return this.cycleDto(this.dataSource.manager, c);
  }

  async createCycle(dto: Dto<typeof createCycle>) {
    const m = this.dataSource.manager;
    if (dto.department_id && !(await m.query(`SELECT 1 FROM department WHERE id = $1`, [dto.department_id])).length) throw unprocessable('department_not_found', 'Unknown department', [{ path: 'department_id', message: 'Not found' }]);
    const c = await m.getRepository(ReviewCycle).save(m.getRepository(ReviewCycle).create({
      name: dto.name, kind: dto.kind, periodStart: dto.period_start, periodEnd: dto.period_end, goalsDue: dto.goals_due, selfReviewDue: dto.self_review_due, managerReviewDue: dto.manager_review_due, departmentId: dto.department_id ?? null, status: 'draft',
    }));
    return this.cycleDto(m, c);
  }

  /**
   * draft → goal_setting creates a review for every active or probation employee in scope
   * (reviewer: the user of their line manager); goal_setting → reviewing opens self-reviews;
   * → closed stops new submissions (approvals and acknowledgements still finish).
   */
  async changeCycleStatus(id: string, to: 'goal_setting' | 'reviewing' | 'closed') {
    const notices: { users: string[]; template: string; vars: Record<string, string> }[] = [];
    await this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(ReviewCycle).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw notFound('Review cycle');
      const allowed: Record<string, string[]> = { draft: ['goal_setting'], goal_setting: ['reviewing', 'closed'], reviewing: ['closed'], closed: [] };
      if (!allowed[c.status].includes(to)) throw conflict('bad_transition', `A ${c.status.replace('_', ' ')} cycle cannot move to ${to.replace('_', ' ')}`);
      if (to === 'goal_setting') {
        const created: { employee_id: string; reviewer_user_id: string | null }[] = await m.query(
          `INSERT INTO performance_review (cycle_id, employee_id, reviewer_user_id)
           SELECT $1, e.id, (SELECT u.id FROM user_account u WHERE u.employee_id = e.manager_id AND u.status = 'active' AND u.deleted_at IS NULL LIMIT 1)
             FROM employee e
            WHERE e.deleted_at IS NULL AND e.status IN ('active', 'probation') AND e.hire_date <= $2
              AND ($3::uuid IS NULL OR e.department_id IN (SELECT id FROM department WHERE id = $3 OR path && ARRAY[$3::uuid]))
           ON CONFLICT (cycle_id, employee_id) DO NOTHING
           RETURNING employee_id, reviewer_user_id`,
          [c.id, c.periodEnd, c.departmentId],
        );
        c.launchedAt = new Date();
        const staff: { id: string }[] = await m.query(`SELECT id FROM user_account WHERE employee_id = ANY($1::uuid[]) AND status = 'active'`, [created.map((x) => x.employee_id)]);
        notices.push({ users: [...staff.map((s) => s.id), ...created.map((x) => x.reviewer_user_id).filter((x): x is string => !!x)], template: 'review_cycle_launched', vars: { cycle: c.name, goals_due: c.goalsDue } });
      }
      if (to === 'reviewing') {
        const moved: { employee_id: string }[] = await m.query(`UPDATE performance_review SET status = 'self_review', updated_at = now(), version = version + 1 WHERE cycle_id = $1 AND status = 'goal_setting' RETURNING employee_id`, [c.id]);
        const staff: { id: string }[] = await m.query(`SELECT id FROM user_account WHERE employee_id = ANY($1::uuid[]) AND status = 'active'`, [moved.map((x) => x.employee_id)]);
        notices.push({ users: staff.map((s) => s.id), template: 'self_review_open', vars: { cycle: c.name, due: c.selfReviewDue } });
      }
      c.status = to;
      await m.getRepository(ReviewCycle).save(c);
      await writeAudit(m, { action: 'update', entityType: 'ReviewCycle', entityId: c.id, after: { status: to } });
      for (const n of notices) await this.notifications.notifyUsers(n.users, n.template, n.vars, '/me/performance', m);
    });
    return this.cycle(id);
  }

  /** Adds someone who joined (or was missed) after the cycle launched. */
  async addReview(cycleId: string, employeeId: string) {
    const id = await this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(ReviewCycle).findOneBy({ id: cycleId });
      if (!c) throw notFound('Review cycle');
      if (c.status === 'draft' || c.status === 'closed') throw conflict('cycle_not_open', 'Reviews can be added only while the cycle is open');
      const [e] = await m.query(`SELECT id, manager_id FROM employee WHERE id = $1 AND deleted_at IS NULL AND status IN ('active', 'probation', 'onboarding')`, [employeeId]);
      if (!e) throw unprocessable('employee_not_found', 'Unknown or inactive employee', [{ path: 'employee_id', message: 'Not found' }]);
      if (await m.getRepository(PerformanceReview).existsBy({ cycleId, employeeId })) throw conflict('exists', 'That person already has a review in this cycle');
      const [u] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [e.manager_id]);
      const r = await m.getRepository(PerformanceReview).save(m.getRepository(PerformanceReview).create({ cycleId, employeeId, reviewerUserId: u?.id ?? null, status: c.status === 'reviewing' ? 'self_review' : 'goal_setting' }));
      return r.id;
    });
    return id;
  }

  async cycleReport(id: string) {
    await this.cycle(id);
    const bands = new Map<string, number>();
    const finals: { final_rating: string }[] = await this.dataSource.query(`SELECT final_rating FROM performance_review WHERE cycle_id = $1 AND final_rating IS NOT NULL AND status IN ('acknowledgement', 'completed')`, [id]);
    const scale = await this.bands();
    for (const f of finals) bands.set(ratingBand(f.final_rating, scale)!, (bands.get(ratingBand(f.final_rating, scale)!) ?? 0) + 1);
    const depts: { department_name: string | null; reviews: number; completed: number; average: string | null }[] = await this.dataSource.query(
      `SELECT d.name AS department_name, count(r.id)::int AS reviews, count(r.id) FILTER (WHERE r.status = 'completed')::int AS completed,
              round(avg(r.final_rating) FILTER (WHERE r.status IN ('acknowledgement', 'completed')), 2)::text AS average
         FROM performance_review r JOIN employee e ON e.id = r.employee_id LEFT JOIN department d ON d.id = e.department_id
        WHERE r.cycle_id = $1 GROUP BY d.name ORDER BY d.name`,
      [id],
    );
    return { cycle_id: id, bands: [...scale].sort((a, b) => b.min - a.min).map((b) => ({ band: b.label, count: bands.get(b.label) ?? 0 })), departments: depts.map((d) => ({ ...d, average: d.average === null ? null : r2(d.average) })) };
  }

  // ================================================================== reviews
  private async row(m: EntityManager, r: PerformanceReview): Promise<ReviewRow> {
    const [x] = await m.query(
      `SELECT e.first_name || ' ' || e.last_name AS employee_name, e.staff_number, p.title AS position_title, d.name AS department_name, e.branch_id, e.department_id,
              (SELECT display_name FROM user_account WHERE id = $2) AS reviewer_name
         FROM employee e LEFT JOIN position p ON p.id = e.position_id LEFT JOIN department d ON d.id = e.department_id WHERE e.id = $1`,
      [r.employeeId, r.reviewerUserId],
    );
    return x;
  }

  private async roles(access: AccessProfile, r: PerformanceReview, row: ReviewRow) {
    const inScope = async (perm: string) => access.has(perm) && scopeAllows(await this.scope.filterFor(access, perm), { branchId: row.branch_id, departmentId: row.department_id, employeeId: r.employeeId });
    return {
      isEmployee: !!access.employeeId && access.employeeId === r.employeeId,
      isReviewer: !!r.reviewerUserId && r.reviewerUserId === access.actorId,
      reads: await inScope('performance:read'),
      manages: await inScope('performance:manage'),
    };
  }

  private async load(access: AccessProfile, id: string, m: EntityManager = this.dataSource.manager, lock = false) {
    const r = await m.getRepository(PerformanceReview).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!r) throw notFound('Review');
    const c = await m.getRepository(ReviewCycle).findOneByOrFail({ id: r.cycleId });
    const row = await this.row(m, r);
    const who = await this.roles(access, r, row);
    if (!who.isEmployee && !who.isReviewer && !who.reads && !who.manages) throw notFound('Review');
    return { r, c, row, who };
  }

  private async bands(m?: EntityManager) {
    return this.settings.get('performance.rating_bands', m);
  }

  private summary(r: PerformanceReview, c: ReviewCycle, row: ReviewRow, goals: number, bands: { min: number; label: string }[]) {
    return {
      id: r.id, cycle_id: r.cycleId, cycle_name: c.name, employee_id: r.employeeId, employee_name: row.employee_name, staff_number: row.staff_number, position_title: row.position_title, department_name: row.department_name,
      reviewer_user_id: r.reviewerUserId, reviewer_name: row.reviewer_name, status: r.status, self_rating: r2(r.selfRating), manager_rating: r2(r.managerRating), final_rating: r2(r.finalRating), band: ratingBand(r.finalRating, bands),
      goals, updated_at: r.updatedAt.toISOString(), version: r.version,
    };
  }

  private goalDto(g: PerformanceGoal, indicatorName: string | null, hideManager: boolean) {
    return {
      id: g.id, review_id: g.reviewId, indicator_id: g.indicatorId, indicator_name: indicatorName, title: g.title, description: g.description, measure: g.measure, target: g.target, weight: g.weight, status: g.status,
      progress: g.progress, progress_note: g.progressNote, self_score: g.selfScore, self_comment: g.selfComment,
      manager_score: hideManager ? null : g.managerScore, manager_comment: hideManager ? null : g.managerComment, version: g.version,
    };
  }

  async review(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const { r, c, row, who } = await this.load(access, id);
    const goals = await m.getRepository(PerformanceGoal).find({ where: { reviewId: r.id }, order: { createdAt: 'ASC' } });
    const names = new Map<string, string>((await m.query(`SELECT id, name FROM performance_indicator WHERE id = ANY($1::uuid[])`, [goals.map((g) => g.indicatorId).filter(Boolean)])).map((x: { id: string; name: string }) => [x.id, x.name]));
    // The employee sees the manager's assessment only once it has been approved.
    const hideManager = who.isEmployee && !who.isReviewer && !['acknowledgement', 'completed'].includes(r.status);
    const today = await this.settings.today();
    const open = c.status !== 'closed';
    const managerTurn = r.status === 'manager_review' || (r.status === 'self_review' && today > c.selfReviewDue);
    return {
      ...this.summary(r, c, row, goals.filter((g) => g.status === 'agreed').length, await this.bands()),
      ...(hideManager ? { manager_rating: null, final_rating: null, band: null } : {}),
      cycle_status: c.status, period_start: c.periodStart, period_end: c.periodEnd, self_review_due: c.selfReviewDue, manager_review_due: c.managerReviewDue,
      goal_list: goals.map((g) => this.goalDto(g, g.indicatorId ? names.get(g.indicatorId) ?? null : null, hideManager)),
      self_comment: r.selfComment, self_submitted_at: r.selfSubmittedAt?.toISOString() ?? null,
      manager_comment: hideManager ? null : r.managerComment, strengths: hideManager ? null : r.strengths, development_needs: hideManager ? null : r.developmentNeeds, manager_submitted_at: r.managerSubmittedAt?.toISOString() ?? null,
      calibration_comment: hideManager ? null : r.calibrationComment, employee_agrees: r.employeeAgrees, employee_comment: r.employeeComment, acknowledged_at: r.acknowledgedAt?.toISOString() ?? null, workflow_instance_id: r.workflowInstanceId,
      can: {
        edit_goals: (who.isEmployee || who.isReviewer) && r.status === 'goal_setting' && c.status === 'goal_setting',
        agree_goals: who.isReviewer && r.status === 'goal_setting' && c.status === 'goal_setting' && goals.some((g) => g.status === 'proposed'),
        self_review: who.isEmployee && r.status === 'self_review' && open,
        manager_review: who.isReviewer && managerTurn && open,
        calibrate: who.manages && r.status === 'approval',
        acknowledge: who.isEmployee && r.status === 'acknowledgement',
        reassign: who.manages && !['completed', 'approval'].includes(r.status),
      },
    };
  }

  private async summaries(m: EntityManager, rows: PerformanceReview[]) {
    const cycles = new Map((await m.getRepository(ReviewCycle).findBy({ id: In([...new Set(rows.map((r) => r.cycleId))]) })).map((c) => [c.id, c]));
    const counts = new Map<string, number>((await m.query(`SELECT review_id, count(*)::int AS n FROM performance_goal WHERE status = 'agreed' AND review_id = ANY($1::uuid[]) GROUP BY review_id`, [rows.map((r) => r.id)])).map((x: { review_id: string; n: number }) => [x.review_id, x.n]));
    const bands = await this.bands(m);
    return Promise.all(rows.map(async (r) => this.summary(r, cycles.get(r.cycleId)!, await this.row(m, r), counts.get(r.id) ?? 0, bands)));
  }

  async reviews(access: AccessProfile, q: { cycle_id?: string; status?: string }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(PerformanceReview).createQueryBuilder('r').innerJoin('employee', 'e', 'e.id = r.employee_id').orderBy('e.last_name', 'ASC').addOrderBy('e.first_name', 'ASC').limit(2000);
    if (q.cycle_id) qb.andWhere('r.cycle_id = :c', { c: q.cycle_id });
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    applyScope(qb, await this.scope.filterFor(access, 'performance:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    return this.summaries(m, await qb.getMany());
  }

  async myReviews(access: AccessProfile) {
    if (!access.employeeId) return [];
    const m = this.dataSource.manager;
    return this.summaries(m, await m.getRepository(PerformanceReview).find({ where: { employeeId: access.employeeId }, order: { createdAt: 'DESC' } }));
  }

  async teamReviews(access: AccessProfile) {
    const m = this.dataSource.manager;
    const rows = await m.getRepository(PerformanceReview).createQueryBuilder('r').innerJoin('review_cycle', 'c', 'c.id = r.cycle_id').where('r.reviewer_user_id = :u', { u: access.actorId }).andWhere(`(c.status <> 'closed' OR r.status <> 'completed')`).orderBy('r.createdAt', 'DESC').take(500).getMany();
    return this.summaries(m, rows);
  }

  async reassign(access: AccessProfile, id: string, reviewerUserId: string) {
    await this.dataSource.transaction(async (m) => {
      const { r, who } = await this.load(access, id, m, true);
      if (!who.manages) throw forbidden('Only performance managers can reassign reviewers');
      if (['completed', 'approval'].includes(r.status)) throw conflict('locked', 'This review can no longer be reassigned');
      const [u] = await m.query(`SELECT id, employee_id FROM user_account WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [reviewerUserId]);
      if (!u) throw unprocessable('user_not_found', 'Unknown or inactive user', [{ path: 'reviewer_user_id', message: 'Not found' }]);
      if (u.employee_id === r.employeeId) throw unprocessable('self_review', 'Nobody can be their own reviewer', [{ path: 'reviewer_user_id', message: 'This is the employee' }]);
      r.reviewerUserId = u.id;
      await m.getRepository(PerformanceReview).save(r);
      await writeAudit(m, { action: 'update', entityType: 'PerformanceReview', entityId: r.id, after: { reviewerUserId: u.id } });
    });
    return this.review(access, id);
  }

  // ---------------------------------------------------------------- goals
  private async assertGoalEditable(m: EntityManager, access: AccessProfile, reviewId: string) {
    const ctx = await this.load(access, reviewId, m, true);
    if (!ctx.who.isEmployee && !ctx.who.isReviewer) throw forbidden('Only the employee and their reviewer set goals');
    if (ctx.r.status !== 'goal_setting' || ctx.c.status !== 'goal_setting') throw conflict('goals_locked', 'Goals can be changed only while the cycle is in goal setting');
    return ctx;
  }

  private async checkIndicator(m: EntityManager, id: string | null | undefined) {
    if (id && !(await m.getRepository(PerformanceIndicator).existsBy({ id, status: 'active' }))) throw unprocessable('indicator_not_found', 'Unknown or inactive indicator', [{ path: 'indicator_id', message: 'Not found' }]);
  }

  async addGoal(access: AccessProfile, reviewId: string, dto: Dto<typeof upsertGoal>) {
    await this.dataSource.transaction(async (m) => {
      await this.assertGoalEditable(m, access, reviewId);
      await this.checkIndicator(m, dto.indicator_id);
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM performance_goal WHERE review_id = $1 AND status <> 'dropped'`, [reviewId]);
      if (n >= 15) throw unprocessable('too_many_goals', 'At most 15 goals in one review');
      await m.getRepository(PerformanceGoal).insert({ reviewId, indicatorId: dto.indicator_id ?? null, title: dto.title, description: dto.description ?? null, measure: dto.measure, target: dto.target ?? null, weight: dto.weight, status: 'proposed' });
    });
    return this.review(access, reviewId);
  }

  async updateGoal(access: AccessProfile, goalId: string, dto: Dto<typeof upsertGoal>, version?: number) {
    const g0 = await this.dataSource.getRepository(PerformanceGoal).findOneBy({ id: goalId });
    if (!g0) throw notFound('Goal');
    await this.dataSource.transaction(async (m) => {
      await this.assertGoalEditable(m, access, g0.reviewId);
      await this.checkIndicator(m, dto.indicator_id);
      const g = await m.getRepository(PerformanceGoal).findOneByOrFail({ id: goalId });
      if (version !== undefined) assertVersion(g.version, version);
      // Any change re-opens agreement on the goal.
      Object.assign(g, { indicatorId: dto.indicator_id ?? null, title: dto.title, description: dto.description ?? null, measure: dto.measure, target: dto.target ?? null, weight: dto.weight, status: 'proposed' });
      await m.getRepository(PerformanceGoal).save(g);
    });
    return this.review(access, g0.reviewId);
  }

  async dropGoal(access: AccessProfile, goalId: string) {
    const g = await this.dataSource.getRepository(PerformanceGoal).findOneBy({ id: goalId });
    if (!g) throw notFound('Goal');
    await this.dataSource.transaction(async (m) => {
      await this.assertGoalEditable(m, access, g.reviewId);
      await m.getRepository(PerformanceGoal).update({ id: g.id }, { status: 'dropped' });
    });
    return this.review(access, g.reviewId);
  }

  /** The reviewer agrees the proposed goals; together the live goals must weigh exactly 100. */
  async agreeGoals(access: AccessProfile, reviewId: string) {
    await this.dataSource.transaction(async (m) => {
      const { who } = await this.assertGoalEditable(m, access, reviewId);
      if (!who.isReviewer) throw forbidden('Only the reviewer agrees goals');
      const goals = await m.getRepository(PerformanceGoal).find({ where: { reviewId } });
      const live = goals.filter((g) => g.status !== 'dropped');
      if (!live.length) throw unprocessable('no_goals', 'Add at least one goal first');
      const total = live.reduce((s, g) => s + g.weight, 0);
      if (total !== 100) throw unprocessable('weights', `Goal weights add up to ${total}; they must add up to 100`, [{ path: 'weight', message: `Total ${total}` }]);
      await m.query(`UPDATE performance_goal SET status = 'agreed', updated_at = now(), version = version + 1 WHERE review_id = $1 AND status = 'proposed'`, [reviewId]);
    });
    return this.review(access, reviewId);
  }

  /** The employee keeps their progress up to date during the period (not once scoring starts). */
  async goalProgress(access: AccessProfile, goalId: string, dto: Dto<typeof goalProgress>) {
    const m = this.dataSource.manager;
    const g = await m.getRepository(PerformanceGoal).findOneBy({ id: goalId });
    if (!g) throw notFound('Goal');
    const { r, c, who } = await this.load(access, g.reviewId);
    if (!who.isEmployee && !who.isReviewer) throw forbidden('Only the employee and their reviewer update progress');
    if (g.status !== 'agreed') throw conflict('not_agreed', 'Only agreed goals have progress');
    if (!['goal_setting', 'self_review'].includes(r.status) || c.status === 'closed') throw conflict('locked', 'Progress can no longer be updated on this review');
    await m.getRepository(PerformanceGoal).update({ id: g.id }, { progress: dto.progress, progressNote: dto.note ?? null });
    return this.review(access, g.reviewId);
  }

  // ---------------------------------------------------------------- assessments
  private async applyScores(m: EntityManager, reviewId: string, scores: { goal_id: string; score?: number | null; comment?: string | null }[], side: 'self' | 'manager') {
    const goals = await m.getRepository(PerformanceGoal).find({ where: { reviewId, status: 'agreed' } });
    for (const s of scores) {
      const g = goals.find((x) => x.id === s.goal_id);
      if (!g) throw unprocessable('unknown_goal', 'A score is for a goal that is not agreed on this review', [{ path: 'scores', message: s.goal_id }]);
      if (side === 'self') Object.assign(g, { selfScore: s.score ?? null, selfComment: s.comment ?? null });
      else Object.assign(g, { managerScore: s.score ?? null, managerComment: s.comment ?? null });
    }
    await m.getRepository(PerformanceGoal).save(goals);
    return goals;
  }

  async saveSelf(access: AccessProfile, id: string, dto: Dto<typeof selfReview>) {
    let notify: string | null = null;
    let name = '';
    await this.dataSource.transaction(async (m) => {
      const { r, c, row, who } = await this.load(access, id, m, true);
      if (!who.isEmployee) throw forbidden('Only the employee writes their self-review');
      if (r.status !== 'self_review' || c.status === 'closed') throw conflict('not_open', 'The self-review is not open');
      const goals = await this.applyScores(m, r.id, dto.scores, 'self');
      r.selfComment = dto.comment ?? null;
      r.selfRating = weightedRating(goals.map((g) => ({ weight: g.weight, score: g.selfScore })));
      if (dto.submit) {
        if (goals.length && r.selfRating === null) throw unprocessable('scores_missing', 'Score every goal before submitting', [{ path: 'scores', message: 'Missing scores' }]);
        r.selfSubmittedAt = new Date();
        r.status = 'manager_review';
        notify = r.reviewerUserId;
        name = row.employee_name;
      }
      await m.getRepository(PerformanceReview).save(r);
      if (notify) await this.notifications.notifyUsers([notify], 'self_review_submitted', { employee: name, cycle: c.name, due: c.managerReviewDue }, `/performance/reviews/${r.id}`, m);
    });
    return this.review(access, id);
  }

  async saveManager(access: AccessProfile, id: string, dto: Dto<typeof managerReview>) {
    await this.dataSource.transaction(async (m) => {
      const { r, c, row, who } = await this.load(access, id, m, true);
      if (!who.isReviewer) throw forbidden('Only the reviewer writes the manager assessment');
      const today = await this.settings.today(m);
      const turn = r.status === 'manager_review' || (r.status === 'self_review' && today > c.selfReviewDue);
      if (!turn || c.status === 'closed') throw conflict('not_open', r.status === 'self_review' ? `The employee has until ${c.selfReviewDue} to finish their self-review` : 'The manager assessment is not open');
      const goals = await this.applyScores(m, r.id, dto.scores, 'manager');
      Object.assign(r, { managerComment: dto.comment ?? null, strengths: dto.strengths ?? null, developmentNeeds: dto.development_needs ?? null });
      r.managerRating = goals.length ? weightedRating(goals.map((g) => ({ weight: g.weight, score: g.managerScore }))) : dto.overall_rating ? new Decimal(dto.overall_rating).toFixed(2) : null;
      if (dto.submit) {
        if (r.managerRating === null) throw unprocessable('scores_missing', goals.length ? 'Score every goal before submitting' : 'Give an overall rating', [{ path: goals.length ? 'scores' : 'overall_rating', message: 'Missing' }]);
        if (!r.managerComment) throw unprocessable('comment_required', 'Add an overall comment', [{ path: 'comment', message: 'Required' }]);
        r.managerSubmittedAt = new Date();
        r.status = 'approval';
        r.finalRating = null;
        r.calibrationComment = null;
        const instance = await this.workflow.submit(m, {
          requestType: 'performance_review', kind: c.kind, subjectId: r.id, subjectEmployeeId: r.employeeId, requesterUserId: access.actorId, value: Number(r.managerRating),
          summary: `Appraisal of ${row.employee_name} (${c.name}): ${r.managerRating}, ${ratingBand(r.managerRating, await this.bands(m))}`,
        });
        r.workflowInstanceId = instance.id;
      }
      await m.getRepository(PerformanceReview).save(r);
    });
    return this.review(access, id);
  }

  /** HR moderates the rating while the review is with the approvers. */
  async calibrate(access: AccessProfile, id: string, dto: Dto<typeof calibrate>) {
    await this.dataSource.transaction(async (m) => {
      const { r, who } = await this.load(access, id, m, true);
      if (!who.manages) throw forbidden('Only performance managers calibrate ratings');
      if (r.status !== 'approval') throw conflict('not_in_approval', 'Ratings are calibrated while the review is with the approvers');
      const before = r.finalRating;
      Object.assign(r, { finalRating: new Decimal(dto.final_rating).toFixed(2), calibrationComment: dto.comment });
      await m.getRepository(PerformanceReview).save(r);
      await writeAudit(m, { action: 'update', entityType: 'PerformanceReview', entityId: r.id, before: { finalRating: before }, after: { finalRating: r.finalRating, managerRating: r.managerRating, comment: dto.comment } });
    });
    return this.review(access, id);
  }

  private async reviewApproved(m: EntityManager, i: WorkflowInstance) {
    const r = await m.getRepository(PerformanceReview).findOneByOrFail({ id: i.subjectId });
    const c = await m.getRepository(ReviewCycle).findOneByOrFail({ id: r.cycleId });
    r.finalRating = r.finalRating ?? r.managerRating;
    r.status = 'acknowledgement';
    await m.getRepository(PerformanceReview).save(r);
    const [u] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active'`, [r.employeeId]);
    if (u) await this.notifications.notifyUsers([u.id], 'review_ready', { cycle: c.name }, `/performance/reviews/${r.id}`, m);
  }

  private async reviewSentBack(m: EntityManager, i: WorkflowInstance, comment: string | null) {
    const r = await m.getRepository(PerformanceReview).findOneByOrFail({ id: i.subjectId });
    Object.assign(r, { status: 'manager_review', managerSubmittedAt: null, finalRating: null, calibrationComment: comment ? `Sent back: ${comment}` : r.calibrationComment });
    await m.getRepository(PerformanceReview).save(r);
  }

  async acknowledge(access: AccessProfile, id: string, dto: Dto<typeof acknowledgeReview>) {
    await this.dataSource.transaction(async (m) => {
      const { r, c, row, who } = await this.load(access, id, m, true);
      if (!who.isEmployee) throw forbidden('Only the employee acknowledges their review');
      if (r.status !== 'acknowledgement') throw conflict('not_ready', 'This review is not waiting for you');
      Object.assign(r, { employeeAgrees: dto.agree, employeeComment: dto.comment ?? null, acknowledgedAt: new Date(), status: 'completed' });
      await m.getRepository(PerformanceReview).save(r);
      const band = ratingBand(r.finalRating, await this.bands(m))!;
      await this.outbox.record(m, 'hr.performance.review_completed.v1', r.employeeId, { id: r.id, employee_id: r.employeeId, staff_number: row.staff_number, cycle_id: c.id, cycle_name: c.name, final_rating: r2(r.finalRating)!, band, employee_agrees: dto.agree });
      const reasons: string[] = [];
      if (Number(r.finalRating) < (await this.settings.get('performance.low_rating', m))) reasons.push(`the final rating is ${r2(r.finalRating)} (${band}); consider an improvement plan`);
      if (!dto.agree) reasons.push('the employee does not agree with it');
      if (reasons.length) await this.notifications.notifyPermissionHolders('performance:manage', 'performance_review_flag', { employee: row.employee_name, staff_number: row.staff_number, cycle: c.name, reason: reasons.join(', and ') }, `/performance/reviews/${r.id}`, m);
    });
    return this.review(access, id);
  }
}
