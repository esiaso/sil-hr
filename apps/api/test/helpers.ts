import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedDatabase } from '../src/database/seeds/seed';

export const PASSWORD = 'Test#Password2026';

let shared: Promise<NestExpressApplication> | null = null;

/** One app per test file, seeded with the sample hospital (idempotent across files). */
export function testApp(): Promise<NestExpressApplication> {
  shared ??= (async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    await seedDatabase(app, { sample: true, defaultPassword: PASSWORD });
    return app;
  })();
  return shared;
}

export async function closeApp(): Promise<void> {
  if (!shared) return;
  const app = await shared;
  shared = null;
  await app.close();
}

export const api = (app: NestExpressApplication) => request(app.getHttpServer());

export async function login(app: NestExpressApplication, username: string, password = PASSWORD): Promise<string> {
  const res = await api(app).post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200 || !res.body.access_token) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.access_token as string;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const db = (app: NestExpressApplication) => app.get(DataSource);

/** A short unique suffix for codes, so test files never collide. */
export const uniq = () => Math.random().toString(36).slice(2, 8).toUpperCase();

export async function idOf(app: NestExpressApplication, table: 'branch' | 'department' | 'cost_centre' | 'role' | 'user_account' | 'position', column: string, value: string): Promise<string> {
  const [row] = await db(app).query(`SELECT id FROM ${table} WHERE ${column} = $1`, [value]);
  if (!row) throw new Error(`${table} ${value} not found`);
  return row.id as string;
}
