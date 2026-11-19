import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './bootstrap';
import { loadEnv } from './config/env';
import { PinoNestLogger, rootLogger } from './common/logger';
import { seedDatabase } from './database/seeds/seed';
import { startInlineJobs } from './jobs';
import { RequestContext } from './common/request-context';
import { SiteConfigService } from './modules/site-config/site-config.module';

async function main() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new PinoNestLogger(), bufferLogs: true });
  configureApp(app, env);
  await app.init();
  if (env.seedOnStart) await seedDatabase(app, { sample: env.seedSample, defaultPassword: env.seedDefaultPassword });
  // Hospital facts from config/site.json, applied when the file has changed since last time.
  try {
    const r = await RequestContext.run({ actorType: 'system', actorName: 'site-config' }, () => app.get(SiteConfigService).apply());
    if (r.applied || r.warnings.length) rootLogger.info({ file: r.file, changes: r.changes.length, warnings: r.warnings }, 'Site configuration');
  } catch (err) {
    rootLogger.error({ err }, 'config/site.json could not be applied; fix it and restart, or apply it from Administration');
  }
  if (env.jobsMode === 'inline') startInlineJobs(app);
  await app.listen(env.port);
  rootLogger.info(`API listening on :${env.port}/${API_PREFIX} (docs at /${API_PREFIX}/docs)`);
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
