import {
  EntityManager,
  EntityMetadata,
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
  ObjectLiteral,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { AuditAction } from '@sil/hr-shared';
import { RequestContext } from '../../common/request-context';
import { AuditLog } from './audit.entity';

/**
 * Columns never written to the trail in clear. Anything ending in Enc (encrypted
 * personal data), Hash or Secret is redacted by suffix as well.
 */
const REDACTED = /(Enc|Hash|Secret|Bidx)$/;
const IGNORED_FIELDS = new Set(['updatedAt', 'updatedBy', 'version']);

/** Tables that are their own log, or delivery plumbing. */
const SKIPPED_ENTITIES = new Set([
  'AuditLog',
  'NumberSequence',
  'OutboxEvent',
  'WebhookDelivery',
  'WebhookAttempt',
  'IdempotencyKey',
  'RefreshToken',
  'LoginHistory',
  'Notification',
  'EmailOutbox',
  'MfaRecoveryCode',
  // Append-only ledger: it is its own trail.
  'LeaveLedger',
]);

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'id' in (value as ObjectLiteral)) return (value as ObjectLiteral).id;
  return value;
}

export function snapshot(metadata: EntityMetadata, entity: ObjectLiteral | undefined): Record<string, unknown> | null {
  if (!entity) return null;
  const out: Record<string, unknown> = {};
  for (const column of metadata.columns) {
    if (column.relationMetadata && !column.propertyName.endsWith('Id')) continue;
    const value = column.getEntityValue(entity);
    if (value === undefined) continue;
    out[column.propertyName] = REDACTED.test(column.propertyName) ? (value ? '[REDACTED]' : null) : normalise(value);
  }
  return out;
}

function changedOnly(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after ?? {})) {
    if (IGNORED_FIELDS.has(key)) continue;
    const bv = before?.[key];
    const av = after![key];
    // Redacted values compare equal as "[REDACTED]"; record that they changed anyway.
    const changed = REDACTED.test(key) ? before !== null && av !== undefined && bv !== av : JSON.stringify(bv) !== JSON.stringify(av);
    if (changed) {
      b[key] = bv ?? null;
      a[key] = av ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

export interface AuditEntryInput {
  action: AuditAction | string;
  entityType: string;
  entityId: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Override the actor (e.g. a login before the context has a user). */
  actor?: { type: string; id: string | null; name: string | null };
}

/** Writes one audit row with the current request's actor, IP and correlation id. */
export async function writeAudit(manager: EntityManager, entry: AuditEntryInput): Promise<void> {
  const ctx = RequestContext.get();
  await manager.getRepository(AuditLog).insert({
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: (entry.before ?? null) as never,
    after: (entry.after ?? null) as never,
    actorType: entry.actor?.type ?? ctx?.actorType ?? 'system',
    actorId: entry.actor ? entry.actor.id : (ctx?.actorId ?? null),
    actorName: entry.actor ? entry.actor.name : (ctx?.actorName ?? 'system'),
    ip: ctx?.ip ?? null,
    userAgent: ctx?.userAgent ?? null,
    correlationId: ctx?.correlationId ?? null,
  });
}

function entityIdOf(metadata: EntityMetadata, entity: ObjectLiteral | undefined): string | null {
  if (!entity) return null;
  const id = metadata.getEntityIdMixedMap(entity);
  if (id === undefined || id === null) return null;
  return typeof id === 'object' ? JSON.stringify(id) : String(id);
}

/**
 * Audits every insert/update/remove done through TypeORM, in the same transaction.
 * Bulk query-builder updates raise no events: services that use them audit explicitly.
 */
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<ObjectLiteral>): void {
    const actorId = RequestContext.get()?.actorId;
    if (!actorId || !event.entity) return;
    if (event.metadata.findColumnWithPropertyName('createdBy') && !event.entity.createdBy) event.entity.createdBy = actorId;
    if (event.metadata.findColumnWithPropertyName('updatedBy')) event.entity.updatedBy = actorId;
  }

  beforeUpdate(event: UpdateEvent<ObjectLiteral>): void {
    const actorId = RequestContext.get()?.actorId;
    if (!actorId || !event.entity) return;
    if (event.metadata.findColumnWithPropertyName('updatedBy')) event.entity.updatedBy = actorId;
  }

  async afterInsert(event: InsertEvent<ObjectLiteral>): Promise<void> {
    if (SKIPPED_ENTITIES.has(event.metadata.name)) return;
    await writeAudit(event.manager, {
      action: AuditAction.CREATE,
      entityType: event.metadata.name,
      entityId: entityIdOf(event.metadata, event.entity),
      after: snapshot(event.metadata, event.entity),
    });
  }

  async afterUpdate(event: UpdateEvent<ObjectLiteral>): Promise<void> {
    if (SKIPPED_ENTITIES.has(event.metadata.name)) return;
    const before = snapshot(event.metadata, event.databaseEntity);
    const after = { ...(before ?? {}), ...(snapshot(event.metadata, event.entity as ObjectLiteral) ?? {}) };
    const diff = changedOnly(before, after);
    if (!diff) return;
    await writeAudit(event.manager, {
      action: AuditAction.UPDATE,
      entityType: event.metadata.name,
      entityId: entityIdOf(event.metadata, event.databaseEntity ?? (event.entity as ObjectLiteral)),
      before: diff.before,
      after: diff.after,
    });
  }

  async afterSoftRemove(event: SoftRemoveEvent<ObjectLiteral>): Promise<void> {
    if (SKIPPED_ENTITIES.has(event.metadata.name)) return;
    await writeAudit(event.manager, {
      action: AuditAction.DELETE,
      entityType: event.metadata.name,
      entityId: entityIdOf(event.metadata, event.databaseEntity ?? event.entity),
      before: snapshot(event.metadata, event.databaseEntity ?? event.entity),
      after: { deletedAt: new Date().toISOString() },
    });
  }

  async afterRemove(event: RemoveEvent<ObjectLiteral>): Promise<void> {
    if (SKIPPED_ENTITIES.has(event.metadata.name)) return;
    const source = event.databaseEntity ?? event.entity;
    const id = event.entityId ?? entityIdOf(event.metadata, source);
    await writeAudit(event.manager, {
      action: AuditAction.DELETE,
      entityType: event.metadata.name,
      entityId: typeof id === 'object' && id !== null ? JSON.stringify(id) : (id as string | null),
      before: snapshot(event.metadata, source),
    });
  }
}
