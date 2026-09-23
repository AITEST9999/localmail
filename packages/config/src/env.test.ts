import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

describe('parseEnv', () => {
  it('coerces ports and boolean flags', () => {
    const env = parseEnv({ API_PORT: '9090', JEV_ENABLED: 'false' });

    expect(env.API_PORT).toBe(9090);
    expect(env.JEV_ENABLED).toBe(false);
    expect(env.MAIL_DOMAIN).toBe('localmail.test');
  });

  it('wires rate-limit settings from environment', () => {
    const env = parseEnv({
      RATE_LIMIT_RPS: '7', RATE_LIMIT_BURST: '13',
      RATE_LIMIT_POD_RPS: '31', RATE_LIMIT_POD_BURST: '61',
    });
    expect(env.RATE_LIMIT_RPS).toBe(7);
    expect(env.RATE_LIMIT_BURST).toBe(13);
    expect(env.RATE_LIMIT_POD_RPS).toBe(31);
    expect(env.RATE_LIMIT_POD_BURST).toBe(61);
  });

  it('requires a TypeSafe key only when Jev is enabled', () => {
    expect(() => parseEnv({ JEV_ENABLED: 'true' })).toThrow(/TYPESAFE_API_KEY/);
  });
});
