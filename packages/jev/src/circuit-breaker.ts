import {
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_FAILURE_WINDOW_MS,
} from './thresholds.js';

/**
 * Simple consecutive-window breaker (design §7.2):
 * 5 failures inside 60s → open for 30s cooldown, then half-open (allow one try).
 */
export class JevCircuitBreaker {
  private failureTimes: number[] = [];
  private openUntil = 0;

  constructor(
    private readonly failureThreshold = CIRCUIT_FAILURE_THRESHOLD,
    private readonly failureWindowMs = CIRCUIT_FAILURE_WINDOW_MS,
    private readonly cooldownMs = CIRCUIT_COOLDOWN_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when live Jev must be skipped (route straight to rules). */
  isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.failureTimes = [];
    this.openUntil = 0;
  }

  recordFailure(): void {
    const now = this.now();
    this.failureTimes = this.failureTimes.filter(
      (time) => now - time <= this.failureWindowMs,
    );
    this.failureTimes.push(now);
    if (this.failureTimes.length >= this.failureThreshold) {
      this.openUntil = now + this.cooldownMs;
      this.failureTimes = [];
    }
  }

  /** Test helper. */
  reset(): void {
    this.failureTimes = [];
    this.openUntil = 0;
  }
}

/** Process-wide breaker shared by classify() calls. */
export const sharedJevCircuitBreaker = new JevCircuitBreaker();
