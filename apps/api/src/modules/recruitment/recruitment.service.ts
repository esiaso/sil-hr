import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import type Redis from 'ioredis';
import PDFDocument from 'pdfkit';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import {
  addCandidate, careersApplicationFields, createAssessment, createOffer, createRequisition, formatDate, interviewFeedback, moveApplication, PERMISSION_CODES, respondOffer, scheduleInterview, upsertPosting,
} from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows, systemAccess } from '../../common/access';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { consumeRateLimit, InjectRedis } from '../../common/redis';
import { RequestContext } from '../../common/request-context';
import { DocumentsService } from '../documents/documents.module';
import { EmployeesService } from '../employees/employees.service';
import { OutboxService } from '../events/events.module';
import { LifecycleService } from '../lifecycle/lifecycle.service';
import { render } from '../lifecycle/letters.service';
import { NotificationsService } from '../notifications/notifications.module';
import { NumberingService } from '../numbering/numbering.module';
import { ScopeService } from '../organisation/scope.service';
import { PayrollService } from '../payroll/payroll.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { ApplicationEvent, Assessment, Candidate, Interview, InterviewFeedback, JobApplication, JobOffer, JobPosting, JobRequisition, type Stage } from './recruitment.entities';

type Dto<T extends z.ZodType> = z.infer<T>;
const m2 = (x: Decimal.Value | null) => (x === null ? null : new Decimal(x).toFixed(2));
const REC_SCORE: Record<string, number> = { strong_yes: 2, yes: 1, no: -1, strong_no: -2 };
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/** Where an application may go next. Rejection and withdrawal are possible from any open stage. */
const NEXT: Record<Stage, Stage[]> = {
  applied: ['screening', 'shortlisted', 'rejected', 'withdrawn'],
  screening: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['interview', 'assessment', 'rejected', 'withdrawn'],
  interview: ['assessment', 'shortlisted', 'offer', 'rejected', 'withdrawn'],
  assessment: ['interview', 'offer', 'rejected', 'withdrawn'],
  offer: ['interview', 'rejected', 'withdrawn'],
  hired: [],
  rejected: ['screening'],
  withdrawn: [],
};

const OFFER_LETTER = `{{organisation.name}}
{{organisation.address}}

Ref: {{offer.number}}
{{today}}

{{candidate.name}}

# Offer of employment: {{position}}

Dear {{candidate.first_name}},

We are pleased to offer you the post of {{position}} in the {{department}} department, on a {{contract_type}} contract starting on {{start_date}}{{end_clause}}.

Your basic salary will be KES {{basic}} a month, paid monthly, together with the allowances and benefits that apply to the post. A probation period of {{probation}} applies. Either party may end the contract with {{notice_days}} days' notice.

{{conditions}}

Please confirm your acceptance by replying to Human Resources before your start date. This offer is subject to satisfactory references, original certificates and, for clinical posts, a current practising licence.

Yours sincerely,

Human Resources
{{organisation.name}}`;

@Injectable()
export class RecruitmentService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
    private readonly settings: SettingsService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly numbering: NumberingService,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
    private readonly employees: EmployeesService,
    private readonly lifecycle: LifecycleService,
    private readonly payroll: PayrollService,
  ) {}

  onModuleInit(): void {
    this.workflow.registerHandler('job_requisition', {
      onApproved: (m, i) => this.requisitionDecided(m, i, 'approved', null),
      onRejected: (m, i, c) => this.requisitionDecided(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.requisitionDecided(m, i, 'returned', c),
    });
    this.workflow.registerHandler('job_offer', {
      onApproved: (m, i) => this.offerApproved(m, i),
      onRejected: (m, i, c) => this.offerDecided(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.offerDecided(m, i, 'returned', c),
    });
  }

  // ================================================================== requisitions
  private async reqDto(m: EntityManager, r: JobRequisition) {
    const [x] = await m.query(
      `SELECT p.title, d.name AS dept, p.headcount,
              (SELECT count(*)::int FROM employee e WHERE e.position_id = p.id AND e.status <> 'exited') AS filled,
              (SELECT first_name || ' ' || last_name FROM employee WHERE id = $2) AS replaces, (SELECT display_name FROM user_account WHERE id = $3) AS requester
         FROM position p LEFT JOIN department d ON d.id = p.department_id WHERE p.id = $1`,
      [r.positionId, r.replacesEmployeeId, r.requestedBy],
    );
    return {
      id: r.id, number: r.number, position_id: r.positionId, position_title: x?.title ?? '', department_name: x?.dept ?? null, headcount: r.headcount, hired: r.hired, employment_type: r.employmentType as 'permanent',
      reason: r.reason, replaces_employee_id: r.replacesEmployeeId, replaces_employee_name: x?.replaces ?? null, salary_min: m2(r.salaryMin), salary_max: m2(r.salaryMax), needed_by: r.neededBy,
      justification: r.justification, status: r.status, requested_by_name: x?.requester ?? null, decision_comment: r.decisionComment, workflow_instance_id: r.workflowInstanceId,
      vacancies: Math.max(0, (x?.headcount ?? 0) - (x?.filled ?? 0)), created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(), version: r.version,
    };
  }

  async requisitions(access: AccessProfile, q: { status?: string }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(JobRequisition).createQueryBuilder('r').innerJoin('position', 'p', 'p.id = r.position_id').orderBy('r.createdAt', 'DESC').take(500);
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    applyScope(qb, await this.scope.filterFor(access, access.has('requisition:read') ? 'requisition:read' : 'requisition:request'), { branch: 'p.branch_id', department: 'p.department_id', employee: `'00000000-0000-0000-0000-000000000000'::uuid` });
    return Promise.all((await qb.getMany()).map((r) => this.reqDto(m, r)));
  }

  async createRequisition(access: AccessProfile, dto: Dto<typeof createRequisition>) {
    return this.dataSource.transaction(async (m) => {
      const [p] = await m.query(`SELECT p.id, p.title, p.department_id, d.branch_id FROM position p LEFT JOIN department d ON d.id = p.department_id WHERE p.id = $1 AND p.status = 'active'`, [dto.position_id]);
      if (!p) throw unprocessable('position_not_found', 'Unknown or inactive position', [{ path: 'position_id', message: 'Not found' }]);
      if (!scopeAllows(await this.scope.filterFor(access, 'requisition:request'), { branchId: p.branch_id, departmentId: p.department_id })) throw forbidden('That position is outside your area');
      const r = await m.getRepository(JobRequisition).save(m.getRepository(JobRequisition).create({
        number: await this.numbering.next('job_requisition', { manager: m }), positionId: p.id, headcount: dto.headcount, employmentType: dto.employment_type, reason: dto.reason,
        replacesEmployeeId: dto.replaces_employee_id ?? null, salaryMin: dto.salary_min ?? null, salaryMax: dto.salary_max ?? null, neededBy: dto.needed_by ?? null, justification: dto.justification, status: 'pending', requestedBy: access.actorId,
      }));
      const u: { id: string; employee_id: string | null } | undefined = (await m.query(`SELECT id, employee_id FROM user_account WHERE id = $1`, [access.actorId]))[0];
      const instance = await this.workflow.submit(m, { requestType: 'job_requisition', kind: dto.reason, subjectId: r.id, subjectEmployeeId: u?.employee_id ?? null, requesterUserId: u?.id ?? null, value: dto.headcount, summary: `Recruit ${dto.headcount} × ${p.title} (${dto.reason})` });
      r.workflowInstanceId = instance.id;
      await m.getRepository(JobRequisition).save(r);
      return this.reqDto(m, r);
    });
  }

  private async requisitionDecided(m: EntityManager, i: WorkflowInstance, status: 'approved' | 'rejected' | 'returned', comment: string | null) {
    const r = await m.getRepository(JobRequisition).findOneByOrFail({ id: i.subjectId });
    Object.assign(r, { status, decisionComment: comment });
    await m.getRepository(JobRequisition).save(r);
    if (status === 'approved') {
      const [p] = await m.query(`SELECT department_id FROM position WHERE id = $1`, [r.positionId]);
      await this.outbox.record(m, 'hr.requisition.approved.v1', r.id, { id: r.id, number: r.number, position_id: r.positionId, department_id: p?.department_id ?? null, headcount: r.headcount, employment_type: r.employmentType });
      await this.notifications.notifyPermissionHolders('recruitment:manage', 'requisition_approved', { number: r.number }, '/recruitment', m);
    }
  }

  async cancelRequisition(id: string) {
    const r = await this.dataSource.getRepository(JobRequisition).findOneBy({ id });
    if (!r) throw notFound('Requisition');
    if (['filled', 'cancelled'].includes(r.status)) throw conflict('closed', `The requisition is ${r.status}`);
    r.status = 'cancelled';
    await this.dataSource.getRepository(JobRequisition).save(r);
    await this.dataSource.query(`UPDATE job_posting SET status = 'closed', updated_at = now(), version = version + 1 WHERE requisition_id = $1 AND status <> 'closed'`, [id]);
    return this.reqDto(this.dataSource.manager, r);
  }

  // ================================================================== postings
  private async postingDto(m: EntityManager, p: JobPosting) {
    const r = await m.getRepository(JobRequisition).findOneByOrFail({ id: p.requisitionId });
    const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM job_application WHERE posting_id = $1`, [p.id]);
    return {
      id: p.id, requisition_id: p.requisitionId, requisition_number: r.number, slug: p.slug, title: p.title, summary: p.summary, description: p.description, requirements: p.requirements, location: p.location,
      employment_type: p.employmentType as 'permanent', show_salary: p.showSalary, salary_min: m2(r.salaryMin), salary_max: m2(r.salaryMax), closing_date: p.closingDate, internal_only: p.internalOnly,
      questions: p.questions, status: p.status, published_at: p.publishedAt?.toISOString() ?? null, applications: n, created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString(), version: p.version,
    };
  }

  async postings(q: { status?: string }) {
    const m = this.dataSource.manager;
    const rows = await m.getRepository(JobPosting).find({ where: q.status ? { status: q.status as 'draft' } : {}, order: { createdAt: 'DESC' }, take: 500 });
    return Promise.all(rows.map((p) => this.postingDto(m, p)));
  }

  async savePosting(dto: Dto<typeof upsertPosting>, id?: string, version?: number) {
    return this.dataSource.transaction(async (m) => {
      const r = await m.getRepository(JobRequisition).findOneBy({ id: dto.requisition_id });
      if (!r) throw unprocessable('requisition_not_found', 'Unknown requisition', [{ path: 'requisition_id', message: 'Not found' }]);
      if (dto.status === 'published' && r.status !== 'approved') throw unprocessable('not_approved', 'Only an approved requisition can be advertised', [{ path: 'requisition_id', message: `Requisition is ${r.status}` }]);
      if (dto.status === 'published' && dto.closing_date < (await this.settings.today(m))) throw unprocessable('closed', 'The closing date has passed', [{ path: 'closing_date', message: 'In the past' }]);
      if (new Set(dto.questions.map((x) => x.key)).size !== dto.questions.length) throw unprocessable('duplicate_question', 'Each question needs its own key', [{ path: 'questions', message: 'Duplicate key' }]);
      const repo = m.getRepository(JobPosting);
      const p = id ? await repo.findOneBy({ id }) : repo.create();
      if (!p) throw notFound('Posting');
      if (id && version !== undefined) assertVersion(p.version, version);
      if (!id) p.slug = `${slugify(dto.title)}-${r.number.replace(/\D/g, '').slice(-6)}`;
      if (dto.status === 'published' && p.status !== 'published') p.publishedAt = new Date();
      Object.assign(p, { requisitionId: r.id, title: dto.title, summary: dto.summary ?? null, description: dto.description, requirements: dto.requirements ?? null, location: dto.location ?? null, employmentType: r.employmentType, showSalary: dto.show_salary, closingDate: dto.closing_date, internalOnly: dto.internal_only, questions: dto.questions, status: dto.status });
      return this.postingDto(m, await repo.save(p));
    });
  }

  // ------------------------------------------------------------------ public careers site
  private async organisationName() {
    const [o] = await this.dataSource.query(`SELECT coalesce(legal_name, name) AS name, address FROM organisation ORDER BY created_at LIMIT 1`);
    return o as { name: string; address: string | null } | undefined;
  }

  private publicDto(p: JobPosting, r: JobRequisition, org: string) {
    const salary = p.showSalary && (r.salaryMin || r.salaryMax) ? `KES ${[r.salaryMin, r.salaryMax].filter(Boolean).map((x) => Number(x).toLocaleString('en-KE')).join(' – ')} a month` : null;
    return { slug: p.slug, title: p.title, summary: p.summary, description: p.description, requirements: p.requirements, location: p.location, employment_type: p.employmentType as 'permanent', salary, closing_date: p.closingDate, questions: p.questions, organisation: org };
  }

  private async openPosting(slug: string) {
    const today = await this.settings.today();
    const p = await this.dataSource.getRepository(JobPosting).findOneBy({ slug, status: 'published', internalOnly: false });
    if (!p || p.closingDate < today) throw notFound('Job');
    return p;
  }

  async publicJobs() {
    const today = await this.settings.today();
    const rows = await this.dataSource.getRepository(JobPosting).createQueryBuilder('p').where(`p.status = 'published' AND NOT p.internal_only AND p.closing_date >= :t`, { t: today }).orderBy('p.publishedAt', 'DESC').getMany();
    const org = (await this.organisationName())?.name ?? '';
    const reqs = new Map((await this.dataSource.getRepository(JobRequisition).findBy({ id: In(rows.map((r) => r.requisitionId).concat(['00000000-0000-0000-0000-000000000000'])) })).map((r) => [r.id, r]));
    return rows.map((p) => this.publicDto(p, reqs.get(p.requisitionId)!, org));
  }

  async publicJob(slug: string) {
    const p = await this.openPosting(slug);
    const r = await this.dataSource.getRepository(JobRequisition).findOneByOrFail({ id: p.requisitionId });
    return this.publicDto(p, r, (await this.organisationName())?.name ?? '');
  }

  /**
   * A public application: consent recorded, at most a few per address per hour, one per
   * person per job. The CV is stored as a sensitive document (type and virus checks).
   */
  async publicApply(slug: string, fields: Dto<typeof careersApplicationFields>, cv: Express.Multer.File | undefined, ip: string | undefined) {
    if (fields.website) throw unprocessable('rejected', 'Your application could not be accepted');
    await consumeRateLimit(this.redis, `careers:${ip ?? 'unknown'}`, 5, 3600);
    const p = await this.openPosting(slug);
    let answers: Record<string, string> = {};
    try { answers = fields.answers ? (JSON.parse(fields.answers) as Record<string, string>) : {}; } catch { throw unprocessable('bad_answers', 'The answers could not be read'); }
    for (const q of p.questions) if (q.required && !String(answers[q.key] ?? '').trim()) throw unprocessable('answer_required', `Please answer: ${q.label}`, [{ path: `answers.${q.key}`, message: 'Required' }]);
    answers = Object.fromEntries(p.questions.map((q) => [q.key, String(answers[q.key] ?? '').slice(0, 1000)]));
    if (!cv) throw unprocessable('cv_required', 'Attach your CV (PDF or Word)', [{ path: 'cv', message: 'Required' }]);
    const months = await this.settings.get('recruitment.retention_months');
    const retain = new Date();
    retain.setUTCMonth(retain.getUTCMonth() + months);
    const doc = await RequestContext.run({ actorType: 'system', actorName: 'careers' }, () => this.docs.create({ owner_type: 'candidate', title: `CV: ${fields.first_name} ${fields.last_name}`.slice(0, 200), is_sensitive: 'true', category: 'cv' }, cv, null));
    return this.dataSource.transaction(async (m) => {
      const emailKey = fields.email.trim().toLowerCase();
      const repo = m.getRepository(Candidate);
      const c = (await repo.findOneBy({ email: emailKey })) ?? repo.create({ email: emailKey });
      Object.assign(c, { firstName: fields.first_name, lastName: fields.last_name, phone: fields.phone, location: fields.location ?? null, consentAt: new Date(), retainUntil: retain.toISOString().slice(0, 10) });
      await repo.save(c);
      if (await m.getRepository(JobApplication).existsBy({ postingId: p.id, candidateId: c.id })) throw conflict('already_applied', 'You have already applied for this job. We will be in touch.');
      const a = await m.getRepository(JobApplication).save(m.getRepository(JobApplication).create({ number: await this.appNumber(m), postingId: p.id, candidateId: c.id, source: 'careers', stage: 'applied', cvDocumentId: doc.id, coverNote: fields.cover_note ?? null, answers }));
      await m.getRepository(ApplicationEvent).insert({ applicationId: a.id, actorName: 'Careers site', toStage: 'applied' });
      await m.query(`UPDATE document SET owner_id = $2 WHERE id = $1`, [doc.id, c.id]);
      return { reference: a.number, message: `Thank you, ${fields.first_name}. We have received your application for ${p.title}. Quote ${a.number} if you contact us.` };
    });
  }

  private async appNumber(m: EntityManager) {
    const [{ n }] = await m.query(`SELECT count(*)::int + 1 AS n FROM job_application WHERE created_at >= date_trunc('year', now())`);
    return `APP/${new Date().getUTCFullYear()}/${String(n).padStart(5, '0')}`;
  }

  // ================================================================== applications
  private async appRows(where: string, params: unknown[]) {
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT a.*, p.title AS posting_title, c.first_name || ' ' || c.last_name AS candidate_name, c.email, c.phone, c.location,
              (SELECT count(*)::int FROM interview i WHERE i.application_id = a.id AND i.status <> 'cancelled') AS interviews,
              (SELECT avg(CASE f.recommendation WHEN 'strong_yes' THEN 2 WHEN 'yes' THEN 1 WHEN 'no' THEN -1 ELSE -2 END)::float FROM interview_feedback f JOIN interview i ON i.id = f.interview_id WHERE i.application_id = a.id) AS panel_score
         FROM job_application a JOIN job_posting p ON p.id = a.posting_id JOIN candidate c ON c.id = a.candidate_id WHERE ${where} ORDER BY a.created_at DESC LIMIT 1000`,
      params,
    );
    return rows.map((r) => ({
      id: r.id as string, number: r.number as string, posting_id: r.posting_id as string, posting_title: r.posting_title as string, candidate_id: r.candidate_id as string, candidate_name: r.candidate_name as string,
      email: r.email as string, phone: r.phone as string | null, location: r.location as string | null, source: r.source as 'careers', stage: r.stage as Stage, cv_document_id: r.cv_document_id as string | null,
      cover_note: r.cover_note as string | null, answers: r.answers as Record<string, string>, rating: r.rating as number | null, rejection_reason: r.rejection_reason as string | null,
      hired_employee_id: r.hired_employee_id as string | null, interviews: r.interviews as number, panel_score: r.panel_score === null ? null : Math.round((r.panel_score as number) * 10) / 10,
      created_at: new Date(r.created_at as string).toISOString(),
    }));
  }

  applications(q: { posting_id?: string; stage?: string }) {
    return this.appRows('($1::uuid IS NULL OR a.posting_id = $1) AND ($2::text IS NULL OR a.stage = $2)', [q.posting_id ?? null, q.stage ?? null]);
  }

  async application(id: string) {
    const [a] = await this.appRows('a.id = $1', [id]);
    if (!a) throw notFound('Application');
    const events = (await this.dataSource.getRepository(ApplicationEvent).find({ where: { applicationId: id }, order: { createdAt: 'ASC' } })).map((e) => ({ id: e.id, created_at: e.createdAt.toISOString(), actor_name: e.actorName, from_stage: e.fromStage, to_stage: e.toStage, note: e.note }));
    const interviews = await this.dataSource.getRepository(Interview).find({ where: { applicationId: id }, order: { scheduledAt: 'ASC' } });
    const users = new Map<string, string>((await this.dataSource.query(`SELECT id, display_name FROM user_account WHERE id = ANY($1::uuid[])`, [[...new Set(interviews.flatMap((i) => i.panelUserIds))]])).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));
    const feedback = interviews.length ? await this.dataSource.getRepository(InterviewFeedback).findBy({ interviewId: In(interviews.map((i) => i.id)) }) : [];
    const assessments = await this.dataSource.getRepository(Assessment).find({ where: { applicationId: id }, order: { takenOn: 'ASC' } });
    const offers = await this.dataSource.getRepository(JobOffer).find({ where: { applicationId: id }, order: { createdAt: 'DESC' } });
    return {
      ...a, events,
      interviews_detail: interviews.map((i) => ({
        id: i.id, scheduled_at: i.scheduledAt.toISOString(), duration_minutes: i.durationMinutes, location: i.location, kind: i.kind, status: i.status,
        panel: i.panelUserIds.map((u) => ({ user_id: u, name: users.get(u) ?? '' })),
        feedback: feedback.filter((f) => f.interviewId === i.id).map((f) => ({ user_id: f.userId, name: users.get(f.userId) ?? '', recommendation: f.recommendation, scores: f.scores, comment: f.comment, created_at: f.createdAt.toISOString() })),
      })),
      assessments: assessments.map((x) => ({ id: x.id, name: x.name, score: x.score, max_score: x.maxScore, taken_on: x.takenOn, notes: x.notes })),
      offers: await Promise.all(offers.map((o) => this.offerDto(this.dataSource.manager, o))),
    };
  }

  private async event(m: EntityManager, applicationId: string, from: string | null, to: string | null, note: string | null) {
    const ctx = RequestContext.get();
    await m.getRepository(ApplicationEvent).insert({ applicationId, createdBy: ctx?.actorId ?? null, actorName: ctx?.actorName ?? null, fromStage: from, toStage: to, note });
  }

  async move(id: string, dto: Dto<typeof moveApplication>) {
    await this.dataSource.transaction(async (m) => {
      const a = await m.getRepository(JobApplication).findOneBy({ id });
      if (!a) throw notFound('Application');
      if (dto.stage !== a.stage) {
        if (!NEXT[a.stage].includes(dto.stage)) throw unprocessable('invalid_stage', `From ${a.stage} an application can go to: ${NEXT[a.stage].join(', ') || 'nowhere'}`, [{ path: 'stage', message: 'Not allowed' }]);
        if (dto.stage === 'offer') throw unprocessable('use_offer', 'Make an offer to move to the offer stage');
      }
      const from = a.stage;
      Object.assign(a, { stage: dto.stage, rejectionReason: dto.stage === 'rejected' ? dto.rejection_reason : a.rejectionReason, rating: dto.rating ?? a.rating });
      await m.getRepository(JobApplication).save(a);
      await this.event(m, a.id, from === dto.stage ? null : from, from === dto.stage ? null : dto.stage, dto.note ?? (dto.stage === 'rejected' ? dto.rejection_reason ?? null : null));
    });
    return (await this.appRows('a.id = $1', [id]))[0];
  }

  async addCandidate(dto: Dto<typeof addCandidate>) {
    const newId = await this.dataSource.transaction(async (m) => {
      const p = await m.getRepository(JobPosting).findOneBy({ id: dto.posting_id });
      if (!p) throw notFound('Posting');
      const months = await this.settings.get('recruitment.retention_months', m);
      const retain = new Date();
      retain.setUTCMonth(retain.getUTCMonth() + months);
      const repo = m.getRepository(Candidate);
      const c = (await repo.findOneBy({ email: dto.email.toLowerCase() })) ?? repo.create({ email: dto.email.toLowerCase(), consentAt: new Date() });
      Object.assign(c, { firstName: dto.first_name, lastName: dto.last_name, phone: dto.phone ?? c.phone ?? null, employeeId: dto.employee_id ?? c.employeeId ?? null, retainUntil: retain.toISOString().slice(0, 10) });
      await repo.save(c);
      if (await m.getRepository(JobApplication).existsBy({ postingId: p.id, candidateId: c.id })) throw conflict('already_applied', 'This person has already applied for this job');
      const a = await m.getRepository(JobApplication).save(m.getRepository(JobApplication).create({ number: await this.appNumber(m), postingId: p.id, candidateId: c.id, source: dto.source, stage: 'applied', cvDocumentId: dto.cv_document_id ?? null, coverNote: dto.cover_note ?? null, answers: {} }));
      await this.event(m, a.id, null, 'applied', `Added by HR (${dto.source})`);
      return a.id;
    });
    return (await this.appRows('a.id = $1', [newId]))[0];
  }

  // ================================================================== interviews and assessments
  async schedule(applicationId: string, dto: Dto<typeof scheduleInterview>) {
    return this.dataSource.transaction(async (m) => {
      const a = await m.getRepository(JobApplication).findOneBy({ id: applicationId });
      if (!a) throw notFound('Application');
      if (['hired', 'rejected', 'withdrawn'].includes(a.stage)) throw conflict('closed', `The application is ${a.stage}`);
      const i = await m.getRepository(Interview).save(m.getRepository(Interview).create({ applicationId, scheduledAt: new Date(dto.scheduled_at), durationMinutes: dto.duration_minutes, location: dto.location ?? null, kind: dto.kind, panelUserIds: dto.panel_user_ids }));
      if (['applied', 'screening', 'shortlisted', 'assessment'].includes(a.stage)) {
        await this.event(m, a.id, a.stage, 'interview', `Interview ${dto.scheduled_at}`);
        a.stage = 'interview';
        await m.getRepository(JobApplication).save(a);
      }
      const [x] = await m.query(`SELECT c.first_name || ' ' || c.last_name AS name, p.title FROM candidate c, job_posting p WHERE c.id = $1 AND p.id = $2`, [a.candidateId, a.postingId]);
      await this.notifications.notifyUsers(dto.panel_user_ids, 'interview_scheduled', { candidate: x.name, job: x.title, at: dto.scheduled_at }, '/recruitment/interviews', m);
      return i.id;
    });
  }

/** People who can sit on a panel: active users, by name. */
  async panelMembers() {
    return this.dataSource.query(`SELECT u.id, u.display_name FROM user_account u WHERE u.status = 'active' ORDER BY u.display_name LIMIT 500`) as Promise<{ id: string; display_name: string }[]>;
  }

  async updateInterview(id: string, status: 'scheduled' | 'completed' | 'cancelled' | 'no_show') {
    const i = await this.dataSource.getRepository(Interview).findOneBy({ id });
    if (!i) throw notFound('Interview');
    i.status = status;
    await this.dataSource.getRepository(Interview).save(i);
    return this.application(i.applicationId);
  }

  /** Panel members only, one entry each (they may revise it). */
  async feedback(access: AccessProfile, interviewId: string, dto: Dto<typeof interviewFeedback>) {
    const i = await this.dataSource.getRepository(Interview).findOneBy({ id: interviewId });
    if (!i) throw notFound('Interview');
    if (!i.panelUserIds.includes(access.actorId)) throw forbidden('Only the interview panel can give feedback');
    if (i.status === 'cancelled') throw conflict('cancelled', 'This interview was cancelled');
    const repo = this.dataSource.getRepository(InterviewFeedback);
    const f = (await repo.findOneBy({ interviewId, userId: access.actorId })) ?? repo.create({ interviewId, userId: access.actorId });
    Object.assign(f, { recommendation: dto.recommendation, scores: dto.scores, comment: dto.comment ?? null });
    await repo.save(f);
    if (i.status === 'scheduled' && new Date() >= i.scheduledAt) await this.dataSource.getRepository(Interview).update({ id: i.id }, { status: 'completed' });
    return { ok: true };
  }

  async myInterviews(access: AccessProfile) {
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT i.id, i.application_id, c.first_name || ' ' || c.last_name AS candidate_name, p.title AS posting_title, i.scheduled_at, i.duration_minutes, i.location, i.kind, i.status, a.cv_document_id,
              EXISTS (SELECT 1 FROM interview_feedback f WHERE f.interview_id = i.id AND f.user_id = $1) AS my_feedback
         FROM interview i JOIN job_application a ON a.id = i.application_id JOIN candidate c ON c.id = a.candidate_id JOIN job_posting p ON p.id = a.posting_id
        WHERE $1 = ANY(i.panel_user_ids) AND i.status <> 'cancelled' AND i.scheduled_at > now() - interval '30 days' ORDER BY i.scheduled_at`,
      [access.actorId],
    );
    return rows.map((r) => ({ ...r, scheduled_at: new Date(r.scheduled_at as string).toISOString() }));
  }

  /** A panel member may open the CV of a candidate they interview. */
  async panelCv(access: AccessProfile, interviewId: string) {
    const i = await this.dataSource.getRepository(Interview).findOneBy({ id: interviewId });
    if (!i || !i.panelUserIds.includes(access.actorId)) throw notFound('Interview');
    const a = await this.dataSource.getRepository(JobApplication).findOneByOrFail({ id: i.applicationId });
    if (!a.cvDocumentId) throw notFound('CV');
    return this.docs.read(a.cvDocumentId);
  }

  async cv(applicationId: string) {
    const a = await this.dataSource.getRepository(JobApplication).findOneBy({ id: applicationId });
    if (!a?.cvDocumentId) throw notFound('CV');
    return this.docs.read(a.cvDocumentId);
  }

  async addAssessment(applicationId: string, dto: Dto<typeof createAssessment>) {
    const a = await this.dataSource.getRepository(JobApplication).findOneBy({ id: applicationId });
    if (!a) throw notFound('Application');
    await this.dataSource.getRepository(Assessment).insert({ applicationId, name: dto.name, score: dto.score, maxScore: dto.max_score, takenOn: dto.taken_on, notes: dto.notes ?? null });
    return this.application(applicationId);
  }

  // ================================================================== offers
  private async offerDto(m: EntityManager, o: JobOffer) {
    const [x] = await m.query(`SELECT c.first_name || ' ' || c.last_name AS name, p.title FROM job_application a JOIN candidate c ON c.id = a.candidate_id, position p WHERE a.id = $1 AND p.id = $2`, [o.applicationId, o.positionId]);
    return {
      id: o.id, number: o.number, application_id: o.applicationId, candidate_name: x?.name ?? '', position_id: o.positionId, position_title: x?.title ?? '', contract_type: o.contractType, start_date: o.startDate,
      end_date: o.endDate, basic: m2(o.basic)!, probation_months: o.probationMonths, notice_days: o.noticeDays, conditions: o.conditions, status: o.status, decision_comment: o.decisionComment,
      workflow_instance_id: o.workflowInstanceId, letter_document_id: o.letterDocumentId, responded_at: o.respondedAt?.toISOString() ?? null, employee_id: o.employeeId, created_at: o.createdAt.toISOString(),
    };
  }

  async createOffer(access: AccessProfile, applicationId: string, dto: Dto<typeof createOffer>) {
    return this.dataSource.transaction(async (m) => {
      const a = await m.getRepository(JobApplication).findOneBy({ id: applicationId });
      if (!a) throw notFound('Application');
      if (!['interview', 'assessment', 'offer'].includes(a.stage)) throw unprocessable('not_ready', 'Interview or assess the candidate before making an offer');
      if (await m.getRepository(JobOffer).existsBy({ applicationId, status: In(['pending', 'approved', 'accepted']) })) throw conflict('offer_exists', 'There is already a live offer for this candidate');
      const p = await m.getRepository(JobPosting).findOneByOrFail({ id: a.postingId });
      const r = await m.getRepository(JobRequisition).findOneByOrFail({ id: p.requisitionId });
      if (r.status !== 'approved') throw conflict('requisition_closed', `The requisition is ${r.status}`);
      const o = await m.getRepository(JobOffer).save(m.getRepository(JobOffer).create({
        number: `OFR/${new Date().getUTCFullYear()}/${a.number.split('/').pop()}`, applicationId, positionId: dto.position_id ?? r.positionId, contractType: dto.contract_type, startDate: dto.start_date,
        endDate: dto.end_date ?? null, basic: dto.basic, probationMonths: dto.probation_months ?? null, noticeDays: dto.notice_days, conditions: dto.conditions ?? null, status: 'pending',
      }));
      if (a.stage !== 'offer') { await this.event(m, a.id, a.stage, 'offer', `Offer ${o.number}`); a.stage = 'offer'; await m.getRepository(JobApplication).save(a); }
      const u: { id: string } | undefined = (await m.query(`SELECT id FROM user_account WHERE id = $1`, [access.actorId]))[0];
      const outside = r.salaryMax && new Decimal(dto.basic).gt(r.salaryMax);
      const instance = await this.workflow.submit(m, { requestType: 'job_offer', kind: outside ? 'above_range' : 'within_range', subjectId: o.id, subjectEmployeeId: null, requesterUserId: u?.id ?? null, value: Number(dto.basic), summary: `Offer ${o.number}: KES ${Number(dto.basic).toLocaleString('en-KE')} a month from ${dto.start_date}${outside ? ' (above the approved range)' : ''}` });
      o.workflowInstanceId = instance.id;
      await m.getRepository(JobOffer).save(o);
      return this.offerDto(m, o);
    });
  }

  private async offerDecided(m: EntityManager, i: WorkflowInstance, status: 'rejected' | 'returned', comment: string | null) {
    await m.getRepository(JobOffer).update({ id: i.subjectId }, { status, decisionComment: comment });
  }

  /** Approved: the offer letter (PDF) is produced and kept with the application. */
  private async offerApproved(m: EntityManager, i: WorkflowInstance) {
    const o = await m.getRepository(JobOffer).findOneByOrFail({ id: i.subjectId });
    const a = await m.getRepository(JobApplication).findOneByOrFail({ id: o.applicationId });
    const c = await m.getRepository(Candidate).findOneByOrFail({ id: a.candidateId });
    const [pos] = await m.query(`SELECT p.title, d.name AS dept FROM position p LEFT JOIN department d ON d.id = p.department_id WHERE p.id = $1`, [o.positionId]);
    const org = await this.organisationName();
    const fmt = await this.settings.get('locale.date_format', m);
    const text = render(OFFER_LETTER, {
      'organisation.name': org?.name ?? '', 'organisation.address': org?.address ?? '', 'offer.number': o.number, today: formatDate(await this.settings.today(m), fmt), 'candidate.name': `${c.firstName} ${c.lastName}`,
      'candidate.first_name': c.firstName, position: pos?.title ?? '', department: pos?.dept ?? '', contract_type: o.contractType.replace('_', '-'), start_date: formatDate(o.startDate, fmt),
      end_clause: o.endDate ? ` and ending on ${formatDate(o.endDate, fmt)}` : '', basic: Number(o.basic).toLocaleString('en-KE', { minimumFractionDigits: 2 }), probation: o.probationMonths ? `${o.probationMonths} months` : 'none',
      notice_days: String(o.noticeDays), conditions: o.conditions ?? ' ',
    });
    const body = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 60, info: { Title: `Offer ${o.number}`, Producer: 'SIL HR' } });
      const chunks: Buffer[] = [];
      doc.on('data', (x: Buffer) => chunks.push(x));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      for (const para of text.split(/\n\s*\n/)) {
        const t = para.trim();
        if (!t) continue;
        if (t.startsWith('# ')) doc.font('Helvetica-Bold').fontSize(13).text(t.slice(2));
        else doc.font('Helvetica').fontSize(11).text(t, { lineGap: 2 });
        doc.moveDown(0.8);
      }
      doc.end();
    });
    const d = await this.docs.createFromBuffer({ ownerType: 'candidate', ownerId: c.id, title: `Offer letter ${o.number}`, isSensitive: true, fileName: `offer-${o.number.replace(/\//g, '-')}.pdf`, mimeType: 'application/pdf' }, body);
    Object.assign(o, { status: 'approved', letterDocumentId: d.id });
    await m.getRepository(JobOffer).save(o);
  }

  async offerLetter(offerId: string) {
    const o = await this.dataSource.getRepository(JobOffer).findOneBy({ id: offerId });
    if (!o?.letterDocumentId) throw notFound('Offer letter');
    return this.docs.read(o.letterDocumentId);
  }

  /**
   * The candidate's answer. Accepting makes them an employee from the start date: the
   * record (onboarding, then probation), contract, basic salary and the onboarding
   * checklist; the requisition counts the hire and closes when full.
   */
  async respond(access: AccessProfile, offerId: string, dto: Dto<typeof respondOffer>) {
    return this.dataSource.transaction(async (m) => {
      const o = await m.getRepository(JobOffer).findOneBy({ id: offerId });
      if (!o) throw notFound('Offer');
      if (o.status !== 'approved') throw conflict('not_approved', `The offer is ${o.status}`);
      const a = await m.getRepository(JobApplication).findOneByOrFail({ id: o.applicationId });
      Object.assign(o, { status: dto.response, respondedAt: new Date() });
      if (dto.response !== 'accepted') {
        await m.getRepository(JobOffer).save(o);
        await this.event(m, a.id, null, null, `Offer ${o.number} ${dto.response}${dto.note ? `: ${dto.note}` : ''}`);
        return this.offerDto(m, o);
      }
      const c = await m.getRepository(Candidate).findOneByOrFail({ id: a.candidateId });
      const p = await m.getRepository(JobPosting).findOneByOrFail({ id: a.postingId });
      const r = await m.getRepository(JobRequisition).findOneByOrFail({ id: p.requisitionId });
      if (r.status !== 'approved') throw conflict('requisition_closed', `The requisition is ${r.status}`);
      const sys = systemAccess(access.actorId, 'recruitment', PERMISSION_CODES);
      let employeeId = c.employeeId;
      if (employeeId) {
        // An internal candidate moves to the new post.
        await this.employees.transfer(sys, employeeId, { position_id: o.positionId, effective_from: o.startDate, reason: `Appointed through ${a.number}` }, m);
      } else {
        const probationEnd = o.probationMonths ? new Date(Date.parse(`${o.startDate}T00:00:00Z`)) : null;
        if (probationEnd) probationEnd.setUTCMonth(probationEnd.getUTCMonth() + o.probationMonths!);
        const e = await this.employees.hire(sys, {
          first_name: c.firstName, last_name: c.lastName, personal_email: c.email, personal_phone: c.phone ?? undefined, employment_type: r.employmentType as 'permanent', status: 'onboarding',
          hire_date: o.startDate, probation_end_date: probationEnd ? probationEnd.toISOString().slice(0, 10) : null, position_id: o.positionId,
        }, m);
        employeeId = e.id;
        c.employeeId = e.id;
        await m.getRepository(Candidate).save(c);
      }
      await this.lifecycle.createContract(sys, { employee_id: employeeId, contract_type: o.contractType as 'permanent', position_id: o.positionId, start_date: o.startDate, end_date: o.endDate, probation_months: o.probationMonths, notice_days: o.noticeDays, basic: o.basic, terms: o.conditions, document_id: o.letterDocumentId }, m);
      await this.payroll.setSalary(sys, employeeId, { basic: o.basic, effective_from: o.startDate, reason: `Offer ${o.number}` }, m);
      await this.lifecycle.startChecklist(m, employeeId, 'onboarding', o.startDate);
      o.employeeId = employeeId;
      await m.getRepository(JobOffer).save(o);
      await this.event(m, a.id, a.stage, 'hired', `Offer ${o.number} accepted`);
      Object.assign(a, { stage: 'hired', hiredEmployeeId: employeeId });
      await m.getRepository(JobApplication).save(a);
      r.hired += 1;
      if (r.hired >= r.headcount) {
        r.status = 'filled';
        await m.query(`UPDATE job_posting SET status = 'closed', updated_at = now(), version = version + 1 WHERE requisition_id = $1`, [r.id]);
      }
      await m.getRepository(JobRequisition).save(r);
      return this.offerDto(m, o);
    });
  }

  /** Hourly: close postings past their closing date; forget candidates whose retention ended. */
  async sweep(): Promise<number> {
    const today = await this.settings.today();
    const closed = await this.dataSource.query(`UPDATE job_posting SET status = 'closed', updated_at = now(), version = version + 1 WHERE status = 'published' AND closing_date < $1 RETURNING id`, [today]);
    // Candidates who never became staff and whose consent period ended: personal details are blanked.
    const forgotten = await this.dataSource.query(
      `UPDATE candidate SET first_name = 'Removed', last_name = 'candidate', email = 'removed-' || id || '@invalid', phone = NULL, location = NULL, updated_at = now(), version = version + 1
        WHERE retain_until < $1 AND employee_id IS NULL AND email NOT LIKE 'removed-%' RETURNING id`,
      [today],
    );
    return ((closed[0] as unknown[]) ?? []).length + ((forgotten[0] as unknown[]) ?? []).length;
  }

}
