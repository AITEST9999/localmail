import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { consumeBucket, createMemoryRateLimiter, createRedisRateLimiter } from './rate-limit.js';

describe('token bucket', () => {
  it('consumes burst and refills over time', () => {
    const config = { rate: 2, burst: 2 };
    const first = consumeBucket(2, 0, 0, config);
    const second = consumeBucket(first.tokens, first.lastMs, 0, config);
    const denied = consumeBucket(second.tokens, second.lastMs, 0, config);
    expect(first.allowed).toBe(true); expect(second.allowed).toBe(true); expect(denied.allowed).toBe(false);
    expect(consumeBucket(0, 0, 500, config).allowed).toBe(true);
  });

  it('checks pod ceiling and key independently without consuming on reject', async () => {
    const limiter = createMemoryRateLimiter({ rate: 1, burst: 1 }, { rate: 100, burst: 100 });
    expect((await limiter.consume('pod', 'key')).allowed).toBe(true);
    expect((await limiter.consume('pod', 'key')).allowed).toBe(false);
    expect((await limiter.consume('pod', 'other-key')).allowed).toBe(false);
  });

  it('rejects non-finite Redis bucket configuration before serving requests', () => {
    const redis = { eval: vi.fn() } as unknown as Redis;
    expect(() => createRedisRateLimiter(redis, { rate: Number.NaN, burst: 10 }, { rate: 10, burst: 10 })).toThrow(/Invalid rate-limit bucket config/);
    expect(() => createRedisRateLimiter(redis, { rate: Number.POSITIVE_INFINITY, burst: 10 }, { rate: 10, burst: 10 })).toThrow(/Invalid rate-limit bucket config/);
    expect(() => createRedisRateLimiter(redis, { rate: 10, burst: 10 }, { rate: 10, burst: 0 })).toThrow(/Invalid rate-limit bucket config/);
  });
});
