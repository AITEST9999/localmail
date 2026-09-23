import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_RETRY_DELAYS_MS,
  webhookBackoffDelayMs,
} from './backoff.js';

describe('webhookBackoffDelayMs', () => {
  it('returns the exact configured delays for attempts 1–5', () => {
    expect(webhookBackoffDelayMs(1)).toBe(60_000);
    expect(webhookBackoffDelayMs(2)).toBe(300_000);
    expect(webhookBackoffDelayMs(3)).toBe(1_800_000);
    expect(webhookBackoffDelayMs(4)).toBe(7_200_000);
    expect(webhookBackoffDelayMs(5)).toBe(43_200_000);
    expect([...WEBHOOK_RETRY_DELAYS_MS]).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000, 43_200_000,
    ]);
  });

  it('returns the last delay for attempts beyond 5 (defensive)', () => {
    expect(webhookBackoffDelayMs(6)).toBe(43_200_000);
    expect(webhookBackoffDelayMs(100)).toBe(43_200_000);
  });
});
