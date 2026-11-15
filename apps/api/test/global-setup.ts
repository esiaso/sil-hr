import 'reflect-metadata';
import './env';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { typeOrmOptions } from '../src/database/typeorm-options';

/** Wipes the test database, runs every migration, and flushes the test Redis DB. */
export default async function globalSetup(): Promise<void> {
  const ds = new DataSource({ ...typeOrmOptions(), url: process.env.DATABASE_URL } as never);
  await ds.initialize();
  await ds.query('DROP SCHEMA IF EXISTS public CASCADE');
  await ds.query('CREATE SCHEMA public');
  await ds.runMigrations({ transaction: 'each' });
  await ds.destroy();
  const redis = new Redis(process.env.REDIS_URL!);
  await redis.flushdb();
  await redis.quit();
}
