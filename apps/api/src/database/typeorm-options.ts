import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { loadEnv } from '../config/env';
import { IdempotencyKey } from '../common/idempotency';
import { AuditLog } from '../modules/audit/audit.entity';
import { AuditSubscriber } from '../modules/audit/audit.subscriber';
import { DocumentEntity, DocumentVersion } from '../modules/documents/documents.module';
import { OutboxEvent } from '../modules/events/events.module';
import { ExternalRef } from '../modules/external-refs/external-refs.module';
import { ApiClient, ApiClientSecret } from '../modules/identity-access/api-client.entities';
import { IDENTITY_ENTITIES } from '../modules/identity-access/identity.entities';
import { EmailOutbox, Notification, NotificationTemplate } from '../modules/notifications/notifications.module';
import { NumberingScheme, NumberSequence } from '../modules/numbering/numbering.module';
import { ORGANISATION_ENTITIES } from '../modules/organisation/organisation.entities';
import { Setting } from '../modules/settings/settings.module';
import { WEBHOOK_ENTITIES } from '../modules/webhooks/webhook.entities';
import { SnakeNamingStrategy } from './snake-naming.strategy';

export const ENTITIES = [
  AuditLog,
  Setting,
  NumberingScheme,
  NumberSequence,
  IdempotencyKey,
  ExternalRef,
  ...ORGANISATION_ENTITIES,
  ...IDENTITY_ENTITIES,
  ApiClient,
  ApiClientSecret,
  DocumentEntity,
  DocumentVersion,
  OutboxEvent,
  ...WEBHOOK_ENTITIES,
  NotificationTemplate,
  Notification,
  EmailOutbox,
];

export function typeOrmOptions(overrides: Partial<DataSourceOptions> = {}): DataSourceOptions {
  const env = loadEnv();
  return {
    type: 'postgres',
    url: env.databaseUrl,
    entities: ENTITIES,
    subscribers: [AuditSubscriber],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'schema_migrations',
    migrationsTransactionMode: 'each',
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: env.dbLogging,
    extra: { max: 20, options: '-c timezone=UTC' },
    ...overrides,
  } as DataSourceOptions;
}
