import type { CategoryId } from './thresholds.js';

export type CheckVerdict = 'yes' | 'review' | 'no';
export type ClassifyVerdict = 'act' | 'review' | 'abstain';
export type ClassifySource = 'jev' | 'rules';

export interface CategoryAnswer {
  chosen: CategoryId;
  probabilities: Record<CategoryId, number>;
  confidence: number;
  verdict: ClassifyVerdict;
}

export interface CheckAnswer {
  probability: number;
  verdict: CheckVerdict;
}

/**
 * Persisted in `jev_decisions.answers` (design §4).
 * Same five keys for both live Jev and rules fallback.
 */
export interface JevAnswers {
  source: ClassifySource;
  category: CategoryAnswer;
  spam: CheckAnswer;
  urgent: CheckAnswer;
  needsHuman: CheckAnswer;
  auto: CheckAnswer;
}

export interface ClassifyInput {
  from: string;
  subject: string | null;
  extractedText: string | null;
  text: string | null;
  /** Optional RFC 3834 value when known (helps rules / future P3-17). */
  autoSubmitted?: string | null;
}

export interface ClassifyResult {
  answers: JevAnswers;
  /** Wall-clock ms for the classify path that ran (live or rules). */
  latencyMs: number;
  /** Labels to union onto the message (design §7.4). */
  labels: string[];
}

export function buildClassifyState(input: ClassifyInput): string {
  const body = (input.extractedText ?? input.text ?? '').slice(0, 4000);
  return `From: ${input.from}\nSubject: ${input.subject ?? ''}\n\n${body}`;
}

export function rederiveCheckVerdict(
  probability: number,
  actAbove: number,
  reviewAbove: number,
): CheckVerdict {
  if (probability >= actAbove) return 'yes';
  if (probability >= reviewAbove) return 'review';
  return 'no';
}

export function rederiveClassifyVerdict(
  confidence: number,
  actAbove: number,
  reviewAbove: number,
): ClassifyVerdict {
  if (confidence >= actAbove) return 'act';
  if (confidence >= reviewAbove) return 'review';
  return 'abstain';
}

/** Map answers → additive labels (never removes inbox/unread/etc.). */
export function labelsFromAnswers(answers: JevAnswers): string[] {
  const labels: string[] = [];
  const category = answers.category.chosen;
  if (category !== 'other') labels.push(category);
  if (answers.spam.verdict === 'yes') labels.push('spam');
  if (answers.urgent.verdict === 'yes') labels.push('urgent');
  if (answers.needsHuman.verdict === 'yes') labels.push('needs-human');
  if (answers.auto.verdict === 'yes') labels.push('auto');
  return labels;
}
