/**
 * Pure decision logic for the auto-reply agent — no I/O, so it's cheap to
 * unit-test against every fixture's real applied label set (P4-21).
 *
 * §P4-21: reply only if labels include `support` (or `billing` without
 * `needs-human`), and don't include any of `auto`, `spam`, `needs-human`,
 * `skip_classify`, and the message is inbound. A blocked label always wins,
 * even alongside `support`/`billing` — e.g. `spam` + `support` is not
 * replied to.
 */
export interface ReplyCandidate {
  direction: string;
  labels: string[];
}

const BLOCKED_LABELS = ['auto', 'spam', 'needs-human', 'skip_classify'];

export function shouldAutoReply(message: ReplyCandidate): boolean {
  if (message.direction !== 'inbound') return false;
  const labels = new Set(message.labels);
  if (BLOCKED_LABELS.some((label) => labels.has(label))) return false;
  if (labels.has('support')) return true;
  return labels.has('billing');
}
