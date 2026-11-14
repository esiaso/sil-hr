import { Controller, Get, Global, HttpCode, Injectable, Logger, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import nodemailer, { type Transporter } from 'nodemailer';
import { Column, CreateDateColumn, DataSource, Entity, EntityManager, Index, IsNull, PrimaryColumn } from 'typeorm';
import { z } from 'zod';
import { loadEnv } from '../../config/env';
import { AccessProfile } from '../../common/access';
import { AppBaseEntity } from '../../common/base.entity';
import { Access, RequirePermissions, UsersOnly } from '../../common/decorators';
import { notFound } from '../../common/problem';
import { ZBody, ZResponse } from '../../common/zod';

/** Editable message templates. `{{name}}` placeholders are filled from the variables given. */
@Entity('notification_template')
export class NotificationTemplate extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 80 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  subject: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', array: true, default: () => "'{in_app,email}'" })
  channels: string[];

  @Column({ type: 'varchar', length: 300, nullable: true })
  description: string | null;
}

@Entity('notification')
@Index(['userId', 'readAt'])
export class Notification {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  link: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  readAt: Date | null;
}

/** Mail is queued here in the business transaction and sent by the worker. */
@Entity('email_outbox')
@Index('ix_email_outbox_pending', ['id'], { where: "status = 'pending'" })
export class EmailOutbox {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'varchar', length: 300 })
  toAddress: string;

  @Column({ type: 'varchar', length: 300 })
  subject: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status: 'pending' | 'sent' | 'failed';

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  sentAt: Date | null;
}

export function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => String(vars[k] ?? ''));
}

/** A delivery channel. SMS is added with the SMS gateway connector. */
export interface NotificationChannel {
  readonly name: string;
  send(m: EntityManager, to: { userId: string; email: string | null; phone: string | null }, msg: { title: string; body: string; link?: string | null }): Promise<void>;
}

class InAppChannel implements NotificationChannel {
  readonly name = 'in_app';
  async send(m: EntityManager, to: { userId: string }, msg: { title: string; body: string; link?: string | null }) {
    await m.getRepository(Notification).insert({ userId: to.userId, title: msg.title.slice(0, 200), body: msg.body, link: msg.link ?? null });
  }
}

class EmailChannel implements NotificationChannel {
  readonly name = 'email';
  async send(m: EntityManager, to: { email: string | null }, msg: { title: string; body: string; link?: string | null }) {
    if (!to.email) return;
    const link = msg.link ? `\n\n${loadEnv().publicBaseUrl.replace(/:\d+$/, '')}${msg.link}` : '';
    await m.getRepository(EmailOutbox).insert({ toAddress: to.email, subject: msg.title.slice(0, 300), body: msg.body + link });
  }
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');
  private readonly channels = new Map<string, NotificationChannel>([['in_app', new InAppChannel()], ['email', new EmailChannel()]]);
  private transporter: Transporter | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Sends a templated message to every active user holding the permission. */
  async notifyPermissionHolders(permission: string, templateCode: string, vars: Record<string, string | number | null>, link: string | null, manager: EntityManager = this.dataSource.manager): Promise<number> {
    const users: { id: string; email: string | null; phone: string | null }[] = await manager.query(
      `SELECT DISTINCT u.id, u.email, u.phone FROM user_account u
         JOIN role_assignment ra ON ra.user_id = u.id
         JOIN role_permission rp ON rp.role_id = ra.role_id
        WHERE rp.permission_code = $1 AND u.status = 'active' AND u.deleted_at IS NULL`,
      [permission],
    );
    const tpl = await manager.getRepository(NotificationTemplate).findOneBy({ code: templateCode });
    if (!tpl) {
      this.logger.warn(`Missing notification template ${templateCode}`);
      return 0;
    }
    const msg = { title: render(tpl.subject, vars), body: render(tpl.body, vars), link };
    for (const u of users) {
      for (const c of tpl.channels) await this.channels.get(c)?.send(manager, { userId: u.id, email: u.email, phone: u.phone }, msg);
    }
    return users.length;
  }

  mine(userId: string) {
    return this.dataSource.getRepository(Notification).find({ where: { userId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  async markRead(userId: string, id: string) {
    const res = await this.dataSource.getRepository(Notification).update({ id, userId, readAt: IsNull() }, { readAt: new Date() });
    if (!res.affected && !(await this.dataSource.getRepository(Notification).existsBy({ id, userId }))) throw notFound('Notification');
  }

  /** Worker: sends queued mail. With no SMTP_URL configured mail stays queued. */
  async sendPendingMail(limit = 20): Promise<number> {
    const env = loadEnv();
    if (!env.smtpUrl) return 0;
    this.transporter ??= nodemailer.createTransport(env.smtpUrl);
    let sent = 0;
    await this.dataSource.transaction(async (m) => {
      const rows: EmailOutbox[] = await m.getRepository(EmailOutbox).createQueryBuilder('e').where("e.status = 'pending'").orderBy('e.id').limit(limit).setLock('pessimistic_write').setOnLocked('skip_locked').getMany();
      for (const r of rows) {
        try {
          await this.transporter!.sendMail({ from: env.mailFrom, to: r.toAddress, subject: r.subject, text: r.body });
          await m.getRepository(EmailOutbox).update({ id: r.id }, { status: 'sent', sentAt: new Date(), attempts: r.attempts + 1 });
          sent++;
        } catch (e) {
          await m.getRepository(EmailOutbox).update({ id: r.id }, { attempts: r.attempts + 1, lastError: String((e as Error).message).slice(0, 1000), status: r.attempts + 1 >= 5 ? 'failed' : 'pending' });
        }
      }
    });
    return sent;
  }

  listTemplates() {
    return this.dataSource.getRepository(NotificationTemplate).find({ order: { code: 'ASC' } });
  }

  async updateTemplate(id: string, dto: { subject?: string; body?: string; channels?: string[] }) {
    const repo = this.dataSource.getRepository(NotificationTemplate);
    const t = await repo.findOneBy({ id });
    if (!t) throw notFound('Template');
    Object.assign(t, Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)));
    return repo.save(t);
  }
}

const notificationDto = z.object({ id: z.uuid(), title: z.string(), body: z.string(), link: z.string().nullable(), created_at: z.string(), read_at: z.string().nullable() });
const templateDto = z.object({ id: z.uuid(), code: z.string(), subject: z.string(), body: z.string(), channels: z.array(z.string()), description: z.string().nullable() });
const updateTemplate = z.object({ subject: z.string().trim().min(1).max(200).optional(), body: z.string().min(1).max(20000).optional(), channels: z.array(z.enum(['in_app', 'email'])).min(1).optional() });

@ApiTags('Notifications')
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @UsersOnly()
  @ZResponse(z.array(notificationDto))
  async mine(@Access() access: AccessProfile) {
    return (await this.notifications.mine(access.actorId)).map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, created_at: n.createdAt.toISOString(), read_at: n.readAt?.toISOString() ?? null }));
  }

  @Post('notifications/:id/read')
  @UsersOnly()
  @HttpCode(204)
  @ZResponse(null, 204)
  read(@Access() access: AccessProfile, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(access.actorId, id);
  }

  @Get('notification-templates')
  @RequirePermissions('setting:read')
  @ZResponse(z.array(templateDto))
  async templates() {
    return (await this.notifications.listTemplates()).map((t) => ({ id: t.id, code: t.code, subject: t.subject, body: t.body, channels: t.channels, description: t.description }));
  }

  @Patch('notification-templates/:id')
  @RequirePermissions('setting:manage')
  @ZResponse(templateDto)
  async updateTemplate(@Param('id', ParseUUIDPipe) id: string, @ZBody(updateTemplate) dto: z.infer<typeof updateTemplate>) {
    const t = await this.notifications.updateTemplate(id, dto);
    return { id: t.id, code: t.code, subject: t.subject, body: t.body, channels: t.channels, description: t.description };
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NotificationTemplate, Notification, EmailOutbox])],
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
