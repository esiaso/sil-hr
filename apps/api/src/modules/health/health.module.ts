import { Controller, Get, Inject, Module, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { loadEnv } from '../../config/env';
import { safeEqual } from '../../common/crypto';
import { Public } from '../../common/decorators';
import { metricsRegistry } from '../../common/logger';
import { forbidden } from '../../common/problem';
import { InjectRedis } from '../../common/redis';
import { OBJECT_STORAGE, type ObjectStorage } from '../documents/storage';
import type { AuthedRequest } from '../identity-access/auth.guard';

@ApiTags('Operations')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** Liveness: the process is up. */
  @Get()
  @Public()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies answer. 503 if any does not. */
  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) res: Response) {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
        return 'ok';
      } catch {
        return 'down';
      }
    };
    const checks = {
      database: await check(() => this.dataSource.query('SELECT 1')),
      redis: await check(() => this.redis.ping()),
      object_storage: await check(async () => {
        if (!(await this.storage.ready())) throw new Error('down');
      }),
    };
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}

/** Prometheus metrics: a bearer token with system:metrics, or METRICS_TOKEN for scrapers. */
@ApiTags('Operations')
@Controller('metrics')
export class MetricsController {
  @Get()
  @Public()
  async metrics(@Req() req: AuthedRequest & Request, @Res() res: Response) {
    const token = loadEnv().metricsToken;
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const allowed = req.access?.has('system:metrics') || (token && bearer && safeEqual(bearer, token));
    if (!allowed) throw forbidden('Requires system:metrics or the metrics token');
    res.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
  }
}

@Module({ controllers: [HealthController, MetricsController] })
export class HealthModule {}
