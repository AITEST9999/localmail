import { describe, expect, it } from 'vitest';

import { HopLimitExceededError, nextHopCount } from '../index.js';

describe('nextHopCount', () => {
  it('increments a new or existing chain', () => {
    expect(nextHopCount(undefined, 3)).toBe(1);
    expect(nextHopCount(2, 3)).toBe(3);
  });

  it('refuses another send once the cap is reached', () => {
    expect(() => nextHopCount(3, 3)).toThrow(HopLimitExceededError);
  });
});
