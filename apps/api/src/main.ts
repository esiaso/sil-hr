import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './bootstrap';
import { loadEnv } from './config/env';
import { PinoNestLogger, rootLogger } from './common/logger';
import { seedDatabase } from './database/seeds/seed';
import { startInlineJobs } from './jobs';

async function main() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new PinoNestLogger(), bufferLogs: true });
  configureApp(app, env);
  await app.init();
  if (env.seedOnStart) await seedDatabase(app, { sample: env.seedSample, defaultPassword: env.seedDefaultPassword });
  if (env.jobsMode === 'inline') startInlineJobs(app);
  await app.listen(env.port);
  rootLogger.info(`API listening on :${env.port}/${API_PREFIX} (docs at /${API_PREFIX}/docs)`);
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
