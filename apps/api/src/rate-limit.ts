import type { Redis } from 'ioredis';

export interface BucketConfig { rate: number; burst: number }
export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number; scope?: 'key' | 'pod' }

/** Pure token-bucket math, used by the Redis implementation and unit tests. */
export function consumeBucket(tokens: number, lastMs: number, nowMs: number, config: BucketConfig): RateLimitResult & { tokens: number; lastMs: number } {
  const replenished = Math.min(config.burst, tokens + Math.max(0, nowMs - lastMs) * config.rate / 1000);
  if (replenished < 1) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - replenished) / config.rate)), tokens: replenished, lastMs: nowMs };
  }
  return { allowed: true, retryAfterSeconds: 0, tokens: replenished - 1, lastMs: nowMs };
}

const SCRIPT = `
local now = tonumber(ARGV[1]); local podRate = tonumber(ARGV[2]); local podBurst = tonumber(ARGV[3]); local keyRate = tonumber(ARGV[4]); local keyBurst = tonumber(ARGV[5])
local function refill(k, rate, burst)
  local t = tonumber(redis.call('HGET', k, 'tokens')) or burst
  local last = tonumber(redis.call('HGET', k, 'last')) or now
  t = math.min(burst, t + math.max(0, now-last) * rate / 1000)
  return t
end
local pod = refill(KEYS[1], podRate, podBurst); local key = refill(KEYS[2], keyRate, keyBurst)
if pod < 1 then return {0, math.max(1, math.ceil((1-pod)/podRate)), 1} end
if key < 1 then return {0, math.max(1, math.ceil((1-key)/keyRate)), 2} end
for _, pair in ipairs({{KEYS[1], pod-1}, {KEYS[2], key-1}}) do redis.call('HSET', pair[1], 'tokens', pair[2], 'last', now); redis.call('EXPIRE', pair[1], 3600) end
return {1, 0}
`;

export interface RateLimiter { consume(podId: string, keyId: string): Promise<RateLimitResult> }

export function createRedisRateLimiter(redis: Redis, podConfig: BucketConfig, keyConfig: BucketConfig): RateLimiter {
  const podRate = Number(podConfig.rate);
  const podBurst = Number(podConfig.burst);
  const keyRate = Number(keyConfig.rate);
  const keyBurst = Number(keyConfig.burst);
  if (![podRate, podBurst, keyRate, keyBurst].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error(
      `Invalid rate-limit bucket config: pod=${podRate}/${podBurst} key=${keyRate}/${keyBurst}`,
    );
  }
  return {
    async consume(podId, keyId) {
      const result = await redis.eval(
        SCRIPT,
        2,
        `ratelimit:pod:${podId}`,
        `ratelimit:key:${keyId}`,
        Date.now(),
        podRate,
        podBurst,
        keyRate,
        keyBurst,
      ) as [number, number, number];
      return { allowed: result[0] === 1, retryAfterSeconds: Number(result[1]), scope: result[2] === 1 ? 'pod' : result[2] === 2 ? 'key' : undefined };
    },
  };
}

export function createMemoryRateLimiter(podConfig: BucketConfig, keyConfig: BucketConfig): RateLimiter {
  const buckets = new Map<string, { tokens: number; lastMs: number }>();
  return { consume(podId, keyId) {
    const now = Date.now(); const podKey = `p:${podId}`; const keyKey = `k:${keyId}`;
    const pod = buckets.get(podKey) ?? { tokens: podConfig.burst, lastMs: now };
    const key = buckets.get(keyKey) ?? { tokens: keyConfig.burst, lastMs: now };
    const p = consumeBucket(pod.tokens, pod.lastMs, now, podConfig); const k = consumeBucket(key.tokens, key.lastMs, now, keyConfig);
    if (!p.allowed || !k.allowed) return Promise.resolve({ allowed: false, retryAfterSeconds: Math.max(p.retryAfterSeconds, k.retryAfterSeconds), scope: !p.allowed ? 'pod' : 'key' });
    buckets.set(podKey, { tokens: p.tokens, lastMs: p.lastMs }); buckets.set(keyKey, { tokens: k.tokens, lastMs: k.lastMs });
    return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
  }};
}
