import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PinoNestLogger, rootLogger } from './common/logger';
import { startQueueWorker } from './jobs';

/** Separate worker process: publishes the outbox, delivers webhooks, sends mail. */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: new PinoNestLogger() });
  const stop = await startQueueWorker(app);
  rootLogger.info('Worker started');
  const shutdown = async (signal: string) => {
    rootLogger.info(`Worker stopping (${signal})`);
    await stop();
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
