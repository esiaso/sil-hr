import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { loadEnv } from '../../config/env';
import { PinoNestLogger } from '../../common/logger';
import { seedDatabase } from './seed';

/** `pnpm db:seed [-- --reference-only]`: runs migrations (via the module) and seeds. */
async function main() {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: new PinoNestLogger() });
  await seedDatabase(app, { sample: !process.argv.includes('--reference-only') && env.seedSample, defaultPassword: env.seedDefaultPassword });
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
