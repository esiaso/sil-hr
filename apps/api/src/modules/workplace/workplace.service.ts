import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import { z } from 'zod';
import { createAction, meetingMinutes, policyFields, policyVersionFields, updatePolicy, upsertAnnouncement, upsertMeeting, upsertRoom } from '@sil/hr-shared';
import { AccessProfile, scopeAllows } from '../../common/access';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { loadEnv } from '../../config/env';
import { writeAudit } from '../audit/audit.subscriber';
import { DocumentsService } from '../documents/documents.module';
import { OutboxService } from '../events/events.module';
import { NotificationsService } from '../notifications/notifications.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { toIcs, type IcsEvent } from './ics';
import { Announcement, Meeting, MeetingAction, MeetingAttendee, MeetingRoom, PolicyDocument, PolicyVersion } from './workplace.entities';

type Dto<T extends z.ZodType> = z.infer<T>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** SQL: is employee `e` in an audience of branches and departments (empty lists = everyone)? */
const IN_AUDIENCE = (b: string, d: string) =>
  `((cardinality(${b}::uuid[]) = 0 AND cardinality(${d}::uuid[]) = 0) OR e.branch_id = ANY(${b}::uuid[]) OR e.department_id IN (SELECT id FROM department WHERE id = ANY(${d}::uuid[]) OR path && ${d}::uuid[]))`;

export interface CalendarItem { id: string; kind: 'leave' | 'team_leave' | 'holiday' | 'meeting' | 'training' | 'interview' | 'shift'; title: string; all_day: boolean; start: string; end: string; link: string | null; location?: string | null }

@Injectable()
export class WorkplaceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
  ) {}

  private async audienceName(m: EntityManager, branchIds: string[], departmentIds: string[]) {
    if (!branchIds.length && !departmentIds.length) return 'Everyone';
    const [x] = await m.query(`SELECT array_to_string(array(SELECT name FROM branch WHERE id = ANY($1::uuid[]) UNION ALL SELECT name FROM department WHERE id = ANY($2::uuid[])), ', ') AS names`, [branchIds, departmentIds]);
    return x.names as string;
  }

  private async audienceUsers(m: EntityManager, branchIds: string[], departmentIds: string[]): Promise<string[]> {
    const rows: { id: string }[] = await m.query(
      `SELECT u.id FROM user_account u JOIN employee e ON e.id = u.employee_id
        WHERE u.status = 'active' AND u.deleted_at IS NULL AND e.deleted_at IS NULL AND e.status <> 'exited' AND ${IN_AUDIENCE('$1', '$2')}`,
      [branchIds, departmentIds],
    );
    return rows.map((r) => r.id);
  }

  // ================================================================== announcements
  private async announcementDto(m: EntityManager, a: Announcement) {
    const [u] = await m.query(`SELECT display_name FROM user_account WHERE id = $1`, [a.createdBy]);
    return {
      id: a.id, title: a.title, body: a.body, branch_ids: a.branchIds, department_ids: a.departmentIds, audience: await this.audienceName(m, a.branchIds, a.departmentIds),
      publish_at: a.publishAt.toISOString(), expires_at: a.expiresAt?.toISOString() ?? null, pinned: a.pinned, status: a.status, author_name: u?.display_name ?? null,
      created_at: a.createdAt.toISOString(), updated_at: a.updatedAt.toISOString(), version: a.version,
    };
  }

  /** Live announcements for the caller; with `all`, managers see drafts, scheduled, expired and withdrawn ones too. */
  async announcements(access: AccessProfile, all: boolean) {
    const m = this.dataSource.manager;
    let rows: Announcement[];
    if (all && access.has('announcement:manage')) rows = await m.getRepository(Announcement).find({ order: { publishAt: 'DESC' }, take: 300 });
    else {
      const [e] = access.employeeId ? await m.query(`SELECT branch_id, department_id FROM employee WHERE id = $1`, [access.employeeId]) : [];
      rows = await m.getRepository(Announcement).createQueryBuilder('a')
        .where(`a.status = 'published' AND a.publish_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())`)
        .andWhere(`((cardinality(a.branch_ids) = 0 AND cardinality(a.department_ids) = 0) OR :b = ANY(a.branch_ids) OR EXISTS (SELECT 1 FROM department d WHERE d.id = :d AND (d.id = ANY(a.department_ids) OR d.path && a.department_ids)))`, { b: e?.branch_id ?? null, d: e?.department_id ?? null })
        .orderBy('a.pinned', 'DESC').addOrderBy('a.publishAt', 'DESC').take(100).getMany();
    }
    return Promise.all(rows.map((a) => this.announcementDto(m, a)));
  }

  async saveAnnouncement(dto: Dto<typeof upsertAnnouncement>, id?: string, version?: number) {
    const saved = await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Announcement);
      const a = id ? await repo.findOneBy({ id }) : repo.create();
      if (!a) throw notFound('Announcement');
      if (id && version !== undefined) assertVersion(a.version, version);
      const publishAt = dto.publish_at ? new Date(dto.publish_at) : id ? a.publishAt : new Date();
      if (dto.expires_at && new Date(dto.expires_at) <= publishAt) throw unprocessable('expiry', 'It would expire before it is published', [{ path: 'expires_at', message: 'Before publishing' }]);
      Object.assign(a, { title: dto.title, body: dto.body, branchIds: dto.branch_ids, departmentIds: dto.department_ids, publishAt, expiresAt: dto.expires_at ? new Date(dto.expires_at) : null, pinned: dto.pinned, status: dto.status });
      return repo.save(a);
    });
    await this.publishDue();
    return this.announcementDto(this.dataSource.manager, (await this.dataSource.getRepository(Announcement).findOneBy({ id: saved.id }))!);
  }

  /** Worker and after each save: tell the audience about announcements that have gone live (once each). */
  async publishDue(): Promise<number> {
    return this.dataSource.transaction(async (m) => {
      const due = await m.getRepository(Announcement).createQueryBuilder('a').setLock('pessimistic_write').setOnLocked('skip_locked')
        .where(`a.status = 'published' AND a.notified_at IS NULL AND a.publish_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())`).getMany();
      for (const a of due) {
        await this.notifications.notifyUsers(await this.audienceUsers(m, a.branchIds, a.departmentIds), 'announcement_published', { title: a.title }, '/announcements', m);
        await this.outbox.record(m, 'hr.announcement.published.v1', a.id, { id: a.id, title: a.title, branch_ids: a.branchIds, department_ids: a.departmentIds, publish_at: a.publishAt.toISOString(), expires_at: a.expiresAt?.toISOString() ?? null });
        a.notifiedAt = new Date();
        await m.getRepository(Announcement).save(a);
      }
      return due.length;
    });
  }

  // ================================================================== policies
  private async policyDto(m: EntityManager, p: PolicyDocument) {
    const v = p.currentVersionId ? await m.getRepository(PolicyVersion).findOneBy({ id: p.currentVersionId }) : null;
    const [c] = await m.query(
      `SELECT count(*)::int AS audience, count(a.id)::int AS acked FROM employee e
         LEFT JOIN policy_acknowledgement a ON a.employee_id = e.id AND a.version_id = $3
        WHERE e.deleted_at IS NULL AND e.status NOT IN ('exited') AND ${IN_AUDIENCE("'{}'", '$2')} AND $1::boolean`,
      [true, p.departmentIds, v?.id ?? null],
    );
    return {
      id: p.id, code: p.code, title: p.title, category: p.category as 'hr', description: p.description, department_ids: p.departmentIds, audience: await this.audienceName(m, [], p.departmentIds), requires_ack: p.requiresAck, status: p.status,
      current_version: v ? { id: v.id, version_no: v.versionNo, document_id: v.documentId, effective_from: v.effectiveFrom, changes: v.changes, created_at: v.createdAt.toISOString() } : null,
      acknowledged: c.acked, audience_size: c.audience, created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString(), version: p.version,
    };
  }

  async policies() {
    const m = this.dataSource.manager;
    const rows = await m.getRepository(PolicyDocument).find({ order: { status: 'ASC', title: 'ASC' } });
    return Promise.all(rows.map((p) => this.policyDto(m, p)));
  }

  private async newVersion(m: EntityManager, p: PolicyDocument, effectiveFrom: string, changes: string | null, file: Express.Multer.File | undefined, actor: string) {
    if (!file) throw unprocessable('file_required', 'Attach the policy document', [{ path: 'file', message: 'Required' }]);
    const doc = await this.docs.create({ owner_type: 'policy', owner_id: p.id, title: `${p.code}: ${p.title}`.slice(0, 200), category: 'policy', is_sensitive: 'false' }, file, actor);
    const [{ n }] = await m.query(`SELECT coalesce(max(version_no), 0)::int + 1 AS n FROM policy_version WHERE policy_id = $1`, [p.id]);
    const v = await m.getRepository(PolicyVersion).save(m.getRepository(PolicyVersion).create({ policyId: p.id, versionNo: n, documentId: doc.id, effectiveFrom, changes }));
    p.currentVersionId = v.id;
    await m.getRepository(PolicyDocument).save(p);
    if (p.requiresAck && p.status === 'active') await this.notifications.notifyUsers(await this.audienceUsers(m, [], p.departmentIds), 'policy_published', { title: p.title, version: n }, '/policies', m);
  }

  async createPolicy(access: AccessProfile, f: Dto<typeof policyFields>, file: Express.Multer.File | undefined) {
    const id = await this.dataSource.transaction(async (m) => {
      if (await m.getRepository(PolicyDocument).existsBy({ code: f.code })) throw conflict('duplicate_code', `Policy ${f.code} already exists`);
      const p = await m.getRepository(PolicyDocument).save(m.getRepository(PolicyDocument).create({ code: f.code, title: f.title, category: f.category, description: f.description || null, departmentIds: f.department_ids, requiresAck: f.requires_ack, status: 'active' }));
      await this.newVersion(m, p, f.effective_from, null, file, access.actorId);
      return p.id;
    });
    return this.policyDto(this.dataSource.manager, (await this.dataSource.getRepository(PolicyDocument).findOneBy({ id }))!);
  }

  async addPolicyVersion(access: AccessProfile, id: string, f: Dto<typeof policyVersionFields>, file: Express.Multer.File | undefined) {
    await this.dataSource.transaction(async (m) => {
      const p = await m.getRepository(PolicyDocument).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!p) throw notFound('Policy');
      if (p.status !== 'active') throw conflict('retired', 'The policy is retired');
      await this.newVersion(m, p, f.effective_from, f.changes || null, file, access.actorId);
    });
    return this.policyDto(this.dataSource.manager, (await this.dataSource.getRepository(PolicyDocument).findOneBy({ id }))!);
  }

  async updatePolicy(id: string, dto: Dto<typeof updatePolicy>, version: number) {
    const repo = this.dataSource.getRepository(PolicyDocument);
    const p = await repo.findOneBy({ id });
    if (!p) throw notFound('Policy');
    assertVersion(p.version, version);
    Object.assign(p, { title: dto.title, category: dto.category, description: dto.description ?? null, departmentIds: dto.department_ids, requiresAck: dto.requires_ack, status: dto.status });
    return this.policyDto(this.dataSource.manager, await repo.save(p));
  }

  private async inAudience(m: EntityManager, employeeId: string | null, departmentIds: string[]) {
    if (!employeeId) return false;
    return (await m.query(`SELECT 1 FROM employee e WHERE e.id = $1 AND ${IN_AUDIENCE("'{}'", '$2')}`, [employeeId, departmentIds])).length > 0;
  }

  async myPolicies(access: AccessProfile) {
    if (!access.employeeId) return [];
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT p.id, p.code, p.title, p.category, v.id AS version_id, v.version_no, v.effective_from::text AS effective_from, p.requires_ack, a.acknowledged_at
         FROM policy_document p JOIN policy_version v ON v.id = p.current_version_id
         JOIN employee e ON e.id = $1
         LEFT JOIN policy_acknowledgement a ON a.version_id = v.id AND a.employee_id = e.id
        WHERE p.status = 'active' AND ${IN_AUDIENCE("'{}'", 'p.department_ids')}
        ORDER BY (p.requires_ack AND a.id IS NULL) DESC, p.title`,
      [access.employeeId],
    );
    return rows.map((r) => ({ ...r, acknowledged_at: r.acknowledged_at ? new Date(r.acknowledged_at as string).toISOString() : null })) as never;
  }

  async acknowledgePolicy(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const p = await m.getRepository(PolicyDocument).findOneBy({ id });
    if (!p || p.status !== 'active' || !p.currentVersionId || !(await this.inAudience(m, access.employeeId, p.departmentIds))) throw notFound('Policy');
    await m.query(`INSERT INTO policy_acknowledgement (version_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p.currentVersionId, access.employeeId]);
    await writeAudit(m, { action: 'acknowledge', entityType: 'PolicyDocument', entityId: p.id, after: { versionId: p.currentVersionId } });
    return (await this.myPolicies(access) as { id: string }[]).find((x) => x.id === id);
  }

  async policyFile(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const p = await m.getRepository(PolicyDocument).findOneBy({ id });
    if (!p || !p.currentVersionId) throw notFound('Policy');
    if (!access.has('policy:read') && !access.has('policy:manage') && !(p.status === 'active' && (await this.inAudience(m, access.employeeId, p.departmentIds)))) throw notFound('Policy');
    const v = await m.getRepository(PolicyVersion).findOneByOrFail({ id: p.currentVersionId });
    return this.docs.read(v.documentId);
  }

  async acknowledgements(access: AccessProfile, id: string, pendingOnly: boolean) {
    const m = this.dataSource.manager;
    const p = await m.getRepository(PolicyDocument).findOneBy({ id });
    if (!p) throw notFound('Policy');
    const f = await this.scope.filterFor(access, 'policy:read');
    const rows: { employee_id: string; employee_name: string; staff_number: string; department_name: string | null; acknowledged_at: Date | null; branch_id: string; department_id: string }[] = await m.query(
      `SELECT e.id AS employee_id, e.first_name || ' ' || e.last_name AS employee_name, e.staff_number, d.name AS department_name, a.acknowledged_at, e.branch_id, e.department_id
         FROM employee e LEFT JOIN department d ON d.id = e.department_id
         LEFT JOIN policy_acknowledgement a ON a.employee_id = e.id AND a.version_id = $2
        WHERE e.deleted_at IS NULL AND e.status <> 'exited' AND ${IN_AUDIENCE("'{}'", '$1')}
        ORDER BY (a.id IS NULL) DESC, e.last_name, e.first_name`,
      [p.departmentIds, p.currentVersionId],
    );
    return rows
      .filter((r) => scopeAllows(f, { branchId: r.branch_id, departmentId: r.department_id, employeeId: r.employee_id }))
      .filter((r) => !pendingOnly || !r.acknowledged_at)
      .map(({ branch_id: _b, department_id: _d, ...r }) => ({ ...r, acknowledged_at: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null }));
  }

  // ================================================================== meetings
  private roomDto(r: MeetingRoom) {
    return { id: r.id, name: r.name, location: r.location, capacity: r.capacity, facilities: r.facilities, status: r.status, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(), version: r.version };
  }

  async rooms() {
    return (await this.dataSource.getRepository(MeetingRoom).find({ order: { name: 'ASC' } })).map((r) => this.roomDto(r));
  }

  async saveRoom(dto: Dto<typeof upsertRoom>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(MeetingRoom);
    const r = id ? await repo.findOneBy({ id }) : repo.create();
    if (!r) throw notFound('Room');
    if (id && version !== undefined) assertVersion(r.version, version);
    const clash = await repo.findOneBy({ name: dto.name });
    if (clash && clash.id !== r.id) throw conflict('duplicate_name', 'A room with that name exists');
    Object.assign(r, { name: dto.name, location: dto.location ?? null, capacity: dto.capacity ?? null, facilities: dto.facilities ?? null, status: dto.status });
    return this.roomDto(await repo.save(r));
  }

  async availability(date: string) {
    const tz = await this.settings.get('locale.timezone');
    const rows: { room_id: string; room_name: string; starts_at: Date | null; ends_at: Date | null; title: string | null }[] = await this.dataSource.query(
      `SELECT r.id AS room_id, r.name AS room_name, mt.starts_at, mt.ends_at, mt.title
         FROM meeting_room r LEFT JOIN meeting mt ON mt.room_id = r.id AND mt.status <> 'cancelled'
          AND mt.starts_at < (($1::date + 1)::timestamp AT TIME ZONE $2) AND mt.ends_at > ($1::date::timestamp AT TIME ZONE $2)
        WHERE r.status = 'active' ORDER BY r.name, mt.starts_at`,
      [date, tz],
    );
    const by = new Map<string, { room_id: string; room_name: string; busy: { starts_at: string; ends_at: string; title: string }[] }>();
    for (const r of rows) {
      const x = by.get(r.room_id) ?? { room_id: r.room_id, room_name: r.room_name, busy: [] };
      if (r.starts_at) x.busy.push({ starts_at: new Date(r.starts_at).toISOString(), ends_at: new Date(r.ends_at!).toISOString(), title: r.title! });
      by.set(r.room_id, x);
    }
    return [...by.values()];
  }

  private async meetingSummaries(m: EntityManager, rows: Meeting[], me: string) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const extra: { id: string; room_name: string | null; organiser_name: string; attendees: number; my_response: string | null; open_actions: number }[] = await m.query(
      `SELECT mt.id, r.name AS room_name, u.display_name AS organiser_name,
              (SELECT count(*)::int FROM meeting_attendee a WHERE a.meeting_id = mt.id) AS attendees,
              (SELECT response FROM meeting_attendee a WHERE a.meeting_id = mt.id AND a.user_id = $2) AS my_response,
              (SELECT count(*)::int FROM meeting_action x WHERE x.meeting_id = mt.id AND x.status = 'open') AS open_actions
         FROM meeting mt LEFT JOIN meeting_room r ON r.id = mt.room_id JOIN user_account u ON u.id = mt.organiser_user_id WHERE mt.id = ANY($1::uuid[])`,
      [ids, me],
    );
    const by = new Map(extra.map((x) => [x.id, x]));
    return rows.map((mt) => {
      const x = by.get(mt.id)!;
      return {
        id: mt.id, title: mt.title, room_id: mt.roomId, room_name: x.room_name, location: mt.location, online_link: mt.onlineLink, starts_at: mt.startsAt.toISOString(), ends_at: mt.endsAt.toISOString(),
        organiser_user_id: mt.organiserUserId, organiser_name: x.organiser_name, status: mt.status, attendees: x.attendees, my_response: x.my_response as 'pending' | null, open_actions: x.open_actions, version: mt.version,
      };
    });
  }

  async myMeetings(access: AccessProfile, q: { from?: string; to?: string }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(Meeting).createQueryBuilder('mt')
      .where(`(mt.organiser_user_id = :me OR EXISTS (SELECT 1 FROM meeting_attendee a WHERE a.meeting_id = mt.id AND a.user_id = :me))`, { me: access.actorId })
      .orderBy('mt.startsAt', 'ASC').take(500);
    if (q.from) qb.andWhere('mt.ends_at >= :f', { f: q.from });
    if (q.to) qb.andWhere(`mt.starts_at < (:t::date + 1)`, { t: q.to });
    return this.meetingSummaries(m, await qb.getMany(), access.actorId);
  }

  private async loadMeeting(m: EntityManager, access: AccessProfile, id: string) {
    const mt = await m.getRepository(Meeting).findOneBy({ id });
    if (!mt) throw notFound('Meeting');
    const att = await m.getRepository(MeetingAttendee).findBy({ meetingId: id });
    const organiser = mt.organiserUserId === access.actorId;
    if (!organiser && !att.some((a) => a.userId === access.actorId)) throw notFound('Meeting');
    return { mt, att, organiser };
  }

  async meeting(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const { mt, att, organiser } = await this.loadMeeting(m, access, id);
    const names = new Map<string, string>((await m.query(`SELECT id, display_name FROM user_account WHERE id = ANY($1::uuid[])`, [att.map((a) => a.userId)])).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));
    const [summary] = await this.meetingSummaries(m, [mt], access.actorId);
    return {
      ...summary, agenda: mt.agenda, minutes: mt.minutes, minutes_at: mt.minutesAt?.toISOString() ?? null,
      attendee_list: att.map((a) => ({ user_id: a.userId, name: names.get(a.userId) ?? '', response: a.response, attended: a.attended })).sort((a, b) => a.name.localeCompare(b.name)),
      actions: await this.actionDtos(m, await m.getRepository(MeetingAction).find({ where: { meetingId: id }, order: { createdAt: 'ASC' } })),
      can_edit: organiser,
    };
  }

  private async actionDtos(m: EntityManager, rows: MeetingAction[]) {
    if (!rows.length) return [];
    const info: { id: string; owner_name: string | null; meeting_title: string }[] = await m.query(
      `SELECT x.id, u.display_name AS owner_name, mt.title AS meeting_title FROM meeting_action x JOIN meeting mt ON mt.id = x.meeting_id LEFT JOIN user_account u ON u.id = x.owner_user_id WHERE x.id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    const by = new Map(info.map((i) => [i.id, i]));
    return rows.map((x) => ({ id: x.id, description: x.description, owner_user_id: x.ownerUserId, owner_name: by.get(x.id)?.owner_name ?? null, due_date: x.dueDate, status: x.status, done_at: x.doneAt?.toISOString() ?? null, meeting_id: x.meetingId, meeting_title: by.get(x.id)?.meeting_title ?? '' }));
  }

  private async when(d: Date) {
    const timeZone = await this.settings.get('locale.timezone');
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  }

  private bookingConflict(e: unknown): never {
    if (e instanceof QueryFailedError && (e as unknown as { code?: string }).code === '23P01') throw conflict('room_booked', 'The room is already booked for part of that time');
    throw e;
  }

  async saveMeeting(access: AccessProfile, dto: Dto<typeof upsertMeeting>, id?: string, version?: number) {
    let invited: string[] = [];
    let title = '';
    let starts = new Date();
    const meetingId = await this.dataSource.transaction(async (m) => {
      if (dto.room_id) {
        const r = await m.getRepository(MeetingRoom).findOneBy({ id: dto.room_id });
        if (!r || r.status !== 'active') throw unprocessable('room_not_found', 'Unknown or inactive room', [{ path: 'room_id', message: 'Not found' }]);
        if (r.capacity && dto.attendee_user_ids.length + 1 > r.capacity) throw unprocessable('room_too_small', `${r.name} seats ${r.capacity}`, [{ path: 'room_id', message: 'Too small' }]);
      }
      const users: { id: string }[] = await m.query(`SELECT id FROM user_account WHERE id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL`, [dto.attendee_user_ids]);
      if (users.length !== new Set(dto.attendee_user_ids).size) throw unprocessable('attendee_not_found', 'Someone invited is not an active user', [{ path: 'attendee_user_ids', message: 'Unknown user' }]);
      const repo = m.getRepository(Meeting);
      let mt: Meeting;
      if (id) {
        const found = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!found) throw notFound('Meeting');
        if (found.organiserUserId !== access.actorId) throw forbidden('Only the organiser changes the meeting');
        if (found.status !== 'scheduled') throw conflict('locked', `The meeting is ${found.status}`);
        if (version !== undefined) assertVersion(found.version, version);
        mt = found;
      } else mt = repo.create({ organiserUserId: access.actorId, status: 'scheduled' });
      Object.assign(mt, { title: dto.title, roomId: dto.room_id ?? null, location: dto.location ?? null, onlineLink: dto.online_link ?? null, startsAt: new Date(dto.starts_at), endsAt: new Date(dto.ends_at), agenda: dto.agenda ?? null });
      try {
        mt = await repo.save(mt);
      } catch (e) {
        this.bookingConflict(e);
      }
      const before = new Set((await m.getRepository(MeetingAttendee).findBy({ meetingId: mt.id })).map((a) => a.userId));
      const wanted = new Set(dto.attendee_user_ids.filter((u) => u !== access.actorId));
      const removed = [...before].filter((u) => !wanted.has(u));
      if (removed.length) await m.getRepository(MeetingAttendee).delete({ meetingId: mt.id, userId: In(removed) });
      const added = [...wanted].filter((u) => !before.has(u));
      if (added.length) await m.getRepository(MeetingAttendee).insert(added.map((userId) => ({ meetingId: mt.id, userId })));
      invited = id ? added : [...wanted];
      title = mt.title;
      starts = mt.startsAt;
      return mt.id;
    });
    if (invited.length) await this.notifications.notifyUsers(invited, 'meeting_invite', { title, when: await this.when(starts), organiser: access.actorName }, `/meetings/${meetingId}`);
    return this.meeting(access, meetingId);
  }

  async cancelMeeting(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const { mt, att, organiser } = await this.loadMeeting(m, access, id);
    if (!organiser) throw forbidden('Only the organiser cancels the meeting');
    if (mt.status !== 'scheduled') throw conflict('locked', `The meeting is ${mt.status}`);
    mt.status = 'cancelled';
    await m.getRepository(Meeting).save(mt);
    await this.notifications.notifyUsers(att.map((a) => a.userId), 'meeting_cancelled', { title: mt.title, when: await this.when(mt.startsAt) }, `/meetings/${id}`);
    return this.meeting(access, id);
  }

  async respond(access: AccessProfile, id: string, response: 'accepted' | 'tentative' | 'declined') {
    const m = this.dataSource.manager;
    const { mt } = await this.loadMeeting(m, access, id);
    if (mt.status !== 'scheduled') throw conflict('locked', `The meeting is ${mt.status}`);
    const r = await m.getRepository(MeetingAttendee).update({ meetingId: id, userId: access.actorId }, { response });
    if (!r.affected) throw conflict('not_invited', 'You organise this meeting');
    return this.meeting(access, id);
  }

  async recordMinutes(access: AccessProfile, id: string, dto: Dto<typeof meetingMinutes>) {
    const m = this.dataSource.manager;
    const { mt, att, organiser } = await this.loadMeeting(m, access, id);
    if (!organiser) throw forbidden('Only the organiser records the minutes');
    if (mt.status === 'cancelled') throw conflict('cancelled', 'The meeting was cancelled');
    if (mt.startsAt > new Date()) throw conflict('not_started', 'The meeting has not started');
    const first = mt.status === 'scheduled';
    Object.assign(mt, { minutes: dto.minutes, minutesAt: new Date(), status: 'held' });
    await m.getRepository(Meeting).save(mt);
    for (const a of att) await m.getRepository(MeetingAttendee).update({ meetingId: id, userId: a.userId }, { attended: dto.attended_user_ids.includes(a.userId) });
    if (first) await this.notifications.notifyUsers(att.map((a) => a.userId), 'meeting_minutes', { title: mt.title }, `/meetings/${id}`);
    return this.meeting(access, id);
  }

  async addAction(access: AccessProfile, id: string, dto: Dto<typeof createAction>) {
    const m = this.dataSource.manager;
    const { mt, att, organiser } = await this.loadMeeting(m, access, id);
    if (!organiser) throw forbidden('Only the organiser assigns actions');
    if (dto.owner_user_id && dto.owner_user_id !== mt.organiserUserId && !att.some((a) => a.userId === dto.owner_user_id)) throw unprocessable('not_attendee', 'Actions go to the organiser or an attendee', [{ path: 'owner_user_id', message: 'Not on the meeting' }]);
    await m.getRepository(MeetingAction).insert({ meetingId: id, description: dto.description, ownerUserId: dto.owner_user_id ?? null, dueDate: dto.due_date ?? null, status: 'open' });
    if (dto.owner_user_id && dto.owner_user_id !== access.actorId) await this.notifications.notifyUsers([dto.owner_user_id], 'meeting_action_assigned', { title: mt.title, action: dto.description, due: dto.due_date ?? 'no date' }, '/meetings');
    return this.meeting(access, id);
  }

  async setAction(access: AccessProfile, actionId: string, status: 'open' | 'done') {
    const m = this.dataSource.manager;
    const x = await m.getRepository(MeetingAction).findOneBy({ id: actionId });
    if (!x) throw notFound('Action');
    const mt = await m.getRepository(Meeting).findOneByOrFail({ id: x.meetingId });
    if (x.ownerUserId !== access.actorId && mt.organiserUserId !== access.actorId) throw notFound('Action');
    Object.assign(x, { status, doneAt: status === 'done' ? new Date() : null });
    await m.getRepository(MeetingAction).save(x);
    return (await this.actionDtos(m, [x]))[0];
  }

  async myActions(access: AccessProfile) {
    const m = this.dataSource.manager;
    return this.actionDtos(m, await m.getRepository(MeetingAction).find({ where: { ownerUserId: access.actorId }, order: { status: 'DESC', dueDate: 'ASC' }, take: 300 }));
  }

  async meetingIcs(access: AccessProfile, id: string) {
    const d = await this.meeting(access, id);
    return toIcs(d.title, [{ uid: `meeting-${d.id}@sil-hr`, title: d.title, allDay: false, start: d.starts_at, end: d.ends_at, description: d.agenda, location: [d.room_name, d.location, d.online_link].filter(Boolean).join(', ') || null, status: d.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED', organizer: d.organiser_name }]);
  }

  /** People who can be invited: active users, with their department, matched by name. */
  async invitees(search: string) {
    const q = search.trim().replace(/[%_]/g, '');
    if (q.length < 2) return [];
    return this.dataSource.query(
      `SELECT u.id, u.display_name, d.name AS department_name FROM user_account u LEFT JOIN employee e ON e.id = u.employee_id LEFT JOIN department d ON d.id = e.department_id
        WHERE u.status = 'active' AND u.deleted_at IS NULL AND (u.display_name ILIKE $1 OR e.staff_number ILIKE $1) ORDER BY u.display_name LIMIT 20`,
      [`%${q}%`],
    ) as Promise<{ id: string; display_name: string; department_name: string | null }[]>;
  }

  // ================================================================== calendar
  /** Everything with a date for one user: own leave, holidays, meetings, training, interviews, shifts; team leave when `access` can see it. */
  async calendar(userId: string, employeeId: string | null, from: string, to: string, access?: AccessProfile): Promise<CalendarItem[]> {
    const m = this.dataSource.manager;
    const tz = await this.settings.get('locale.timezone');
    const out: CalendarItem[] = [];
    const [e] = employeeId ? await m.query(`SELECT branch_id FROM employee WHERE id = $1`, [employeeId]) : [];
    if (employeeId) {
      const leave: { id: string; start_date: string; end_date: string; status: string; name: string }[] = await m.query(
        `SELECT r.id, r.start_date::text, r.end_date::text, r.status, t.name FROM leave_request r JOIN leave_type t ON t.id = r.leave_type_id
          WHERE r.employee_id = $1 AND r.status IN ('pending', 'approved') AND r.start_date <= $3 AND r.end_date >= $2`,
        [employeeId, from, to],
      );
      for (const l of leave) out.push({ id: `leave-${l.id}`, kind: 'leave', title: `${l.name}${l.status === 'pending' ? ' (pending)' : ''}`, all_day: true, start: l.start_date, end: l.end_date, link: '/leave' });
      const shifts: { id: string; name: string; s: Date; e: Date }[] = await m.query(
        `SELECT r.id, sh.name, (r.work_date + sh.start_time) AT TIME ZONE $4 AS s,
                (r.work_date + sh.end_time + CASE WHEN sh.end_time <= sh.start_time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE $4 AS e
           FROM roster_entry r JOIN shift sh ON sh.id = r.shift_id WHERE r.employee_id = $1 AND r.kind = 'shift' AND r.work_date BETWEEN $2 AND $3`,
        [employeeId, from, to, tz],
      );
      for (const s of shifts) out.push({ id: `shift-${s.id}`, kind: 'shift', title: s.name, all_day: false, start: new Date(s.s).toISOString(), end: new Date(s.e).toISOString(), link: '/attendance/me' });
      const training: { id: string; title: string; starts_at: Date; ends_at: Date; venue: string | null }[] = await m.query(
        `SELECT x.id, p.title, s.starts_at, s.ends_at, s.venue FROM training_enrolment x JOIN training_session s ON s.id = x.session_id JOIN training_programme p ON p.id = s.programme_id
          WHERE x.employee_id = $1 AND x.status IN ('enrolled', 'attended') AND s.status <> 'cancelled' AND s.starts_at < ($3::date + 1) AND s.ends_at >= $2::date`,
        [employeeId, from, to],
      );
      for (const t of training) out.push({ id: `training-${t.id}`, kind: 'training', title: t.title, all_day: false, start: new Date(t.starts_at).toISOString(), end: new Date(t.ends_at).toISOString(), link: '/me/training', location: t.venue });
    }
    const hols: { id: string; date: string; name: string }[] = await m.query(`SELECT id, date::text, name FROM public_holiday WHERE date BETWEEN $1 AND $2 AND (branch_id IS NULL OR branch_id = $3)`, [from, to, e?.branch_id ?? null]);
    for (const h of hols) out.push({ id: `holiday-${h.id}`, kind: 'holiday', title: h.name, all_day: true, start: h.date, end: h.date, link: null });
    const meetings: { id: string; title: string; starts_at: Date; ends_at: Date; room: string | null; location: string | null }[] = await m.query(
      `SELECT mt.id, mt.title, mt.starts_at, mt.ends_at, r.name AS room, mt.location FROM meeting mt LEFT JOIN meeting_room r ON r.id = mt.room_id
        WHERE mt.status <> 'cancelled' AND (mt.organiser_user_id = $1 OR EXISTS (SELECT 1 FROM meeting_attendee a WHERE a.meeting_id = mt.id AND a.user_id = $1 AND a.response <> 'declined'))
          AND mt.starts_at < ($3::date + 1) AND mt.ends_at >= $2::date`,
      [userId, from, to],
    );
    for (const mt of meetings) out.push({ id: `meeting-${mt.id}`, kind: 'meeting', title: mt.title, all_day: false, start: new Date(mt.starts_at).toISOString(), end: new Date(mt.ends_at).toISOString(), link: `/meetings/${mt.id}`, location: mt.room ?? mt.location });
    const interviews: { id: string; scheduled_at: Date; duration_minutes: number; first_name: string; last_name: string; title: string; location: string | null }[] = await m.query(
      `SELECT i.id, i.scheduled_at, i.duration_minutes, c.first_name, c.last_name, p.title, i.location FROM interview i JOIN job_application a ON a.id = i.application_id JOIN candidate c ON c.id = a.candidate_id JOIN job_posting p ON p.id = a.posting_id
        WHERE $1 = ANY(i.panel_user_ids) AND i.status = 'scheduled' AND i.scheduled_at < ($3::date + 1) AND i.scheduled_at >= $2::date`,
      [userId, from, to],
    );
    for (const i of interviews) out.push({ id: `interview-${i.id}`, kind: 'interview', title: `Interview: ${i.first_name} ${i.last_name} (${i.title})`, all_day: false, start: new Date(i.scheduled_at).toISOString(), end: new Date(new Date(i.scheduled_at).getTime() + i.duration_minutes * 60_000).toISOString(), link: '/recruitment/interviews', location: i.location });
    if (access?.has('leave:read')) {
      const f = await this.scope.filterFor(access, 'leave:read');
      const team: { id: string; start_date: string; end_date: string; who: string; name: string; branch_id: string; department_id: string; employee_id: string }[] = await m.query(
        `SELECT r.id, r.start_date::text, r.end_date::text, e.first_name || ' ' || e.last_name AS who, t.name, e.branch_id, e.department_id, e.id AS employee_id
           FROM leave_request r JOIN employee e ON e.id = r.employee_id JOIN leave_type t ON t.id = r.leave_type_id
          WHERE r.status = 'approved' AND r.start_date <= $2 AND r.end_date >= $1 AND r.employee_id IS DISTINCT FROM $3 LIMIT 500`,
        [from, to, employeeId],
      );
      for (const l of team.filter((x) => scopeAllows(f, { branchId: x.branch_id, departmentId: x.department_id, employeeId: x.employee_id }))) out.push({ id: `team-${l.id}`, kind: 'team_leave', title: `${l.who}: ${l.name}`, all_day: true, start: l.start_date, end: l.end_date, link: '/leave/calendar' });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  async rotateFeed(access: AccessProfile) {
    const token = randomBytes(24).toString('base64url');
    await this.dataSource.query(`INSERT INTO calendar_feed_token (user_id, token_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), last_used_at = NULL`, [access.actorId, sha(token)]);
    await writeAudit(this.dataSource.manager, { action: 'update', entityType: 'CalendarFeed', entityId: access.actorId, after: { rotated: true } });
    return { url: `${loadEnv().publicBaseUrl}/api/v1/calendar-feeds/${token}.ics`, created_at: new Date().toISOString() };
  }

  async removeFeed(access: AccessProfile) {
    await this.dataSource.query(`DELETE FROM calendar_feed_token WHERE user_id = $1`, [access.actorId]);
  }

  /** The secret-URL feed: 30 days back, 180 ahead; own events only (no team leave). */
  async feed(token: string) {
    const [[row]] = await this.dataSource.query(
      `UPDATE calendar_feed_token f SET last_used_at = now() FROM user_account u WHERE f.token_hash = $1 AND u.id = f.user_id AND u.status = 'active' AND u.deleted_at IS NULL RETURNING u.id, u.employee_id, u.display_name`,
      [sha(token)],
    );
    if (!row) throw notFound('Calendar');
    const today = await this.settings.today();
    const shift = (d: number) => { const x = new Date(`${today}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
    const items = await this.calendar(row.id, row.employee_id, shift(-30), shift(180));
    const events: IcsEvent[] = items.map((i) => ({ uid: `${i.id}@sil-hr`, title: i.title, allDay: i.all_day, start: i.start, end: i.end, location: i.location ?? null, url: null }));
    return toIcs(`SIL HR: ${row.display_name}`, events);
  }
}
