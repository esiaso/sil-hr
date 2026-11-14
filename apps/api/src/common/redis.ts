import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { loadEnv } from '../config/env';
import { ProblemException } from './problem';

export const REDIS = Symbol('REDIS');
export const InjectRedis = () => Inject(REDIS);

export function createRedis(url = loadEnv().redisUrl): Redis {
  // BullMQ needs maxRetriesPerRequest: null on connections it uses.
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

class RedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: () => createRedis() }, RedisCloser],
  exports: [REDIS],
})
export class RedisModule {}

/**
 * Fixed-window counter in Redis, shared by every API process.
 * Throws 429 with Retry-After when the limit is exceeded.
 */
export async function consumeRateLimit(redis: Redis, key: string, limit: number, windowSeconds = 60): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const redisKey = `silhr:rl:${key}:${window}`;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, windowSeconds + 1);
  if (count > limit) {
    const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    const ex = new ProblemException(429, 'rate_limited', `Too many requests; try again in ${retryAfter} s`);
    (ex as ProblemException & { retryAfter: number }).retryAfter = retryAfter;
    throw ex;
  }
}
