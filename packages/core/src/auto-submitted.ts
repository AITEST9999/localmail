/** RFC 3834 Auto-Submitted values that short-circuit Jev (P3-17 / PLAN D4.2). */

export const AUTO_SUBMITTED_SHORT_CIRCUIT = [
  'auto-replied',
  'auto-generated',
  'auto-notified',
] as const;

export type AutoSubmittedShortCircuit =
  (typeof AUTO_SUBMITTED_SHORT_CIRCUIT)[number];

/**
 * True when the header value is an automatic reply/bounce/OOO marker.
 * Matches the same set P3-15 rules treat as `auto` when `autoSubmitted` is set.
 */
export function isAutoSubmittedShortCircuit(
  value: string | null | undefined,
): value is AutoSubmittedShortCircuit {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (AUTO_SUBMITTED_SHORT_CIRCUIT as readonly string[]).includes(
    normalized,
  );
}

/** Read a mailparser header value (string | string[] | undefined). */
export function headerString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string');
    return typeof first === 'string' ? first : null;
  }
  return null;
}
