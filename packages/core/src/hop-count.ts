export const DEFAULT_MAX_HOPS = 20;

export class HopLimitExceededError extends Error {
  constructor(
    readonly currentHopCount: number,
    readonly maximumHopCount: number,
  ) {
    super(`Message hop count ${currentHopCount} reached limit ${maximumHopCount}.`);
    this.name = 'HopLimitExceededError';
  }
}

/** Validate the incoming count and return the incremented outbound count. */
export function nextHopCount(
  incomingHopCount: number | null | undefined,
  maximumHopCount = DEFAULT_MAX_HOPS,
): number {
  const current = incomingHopCount ?? 0;
  if (!Number.isSafeInteger(current) || current < 0)
    throw new TypeError('Hop count must be a non-negative safe integer.');
  if (!Number.isSafeInteger(maximumHopCount) || maximumHopCount < 1)
    throw new TypeError('Maximum hop count must be a positive safe integer.');
  if (current >= maximumHopCount)
    throw new HopLimitExceededError(current, maximumHopCount);
  return current + 1;
}
