export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000, // attempt 1 failed → wait 1m before attempt 2
  300_000, // attempt 2 failed → wait 5m before attempt 3
  1_800_000, // attempt 3 failed → wait 30m before attempt 4
  7_200_000, // attempt 4 failed → wait 2h before attempt 5
  43_200_000, // attempt 5 failed → give up
] as const;

export function webhookBackoffDelayMs(attemptsMade: number): number {
  return (
    WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1] ??
    WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1]!
  );
}
