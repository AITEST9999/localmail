/**
 * P3-15 keyword/header heuristics — same five-key shape as live Jev.
 *
 * What this catches (intentionally narrower than a live model):
 * - **category**
 *   - `billing`: charge/charged/invoice/refund/payment/billing
 *   - `otp`: verification code / one-time / OTP / confirm your account + digit runs
 *   - `newsletter`: newsletter / unsubscribe / weekly digest / list-unsubscribe cues in body
 *   - `support`: help request / bug / broken / troubleshooting (weaker; after billing/otp)
 *   - `sales`: quote / demo request / pricing
 *   - else `other`
 * - **spam**: phishing cues (verify password/credit card, account locked, click here + urgent,
 *   lookalike brand pretext). Does **not** try to be a full spam filter.
 * - **urgent**: asap / urgent / immediately / right away / deadline (incl. §9 “ASAP”)
 * - **needsHuman**: refund/complaint/dispute/charged twice/legal — or billing+urgent combo
 * - **auto**: `Auto-Submitted: auto-replied|auto-generated|auto-notified` when provided;
 *   else bounce/OOO subject/from/body markers (MAILER-DAEMON, undelivered, out of office).
 *   Deliberately does **not** mark OTP/newsletter as auto.
 */

import type { CategoryId } from './thresholds.js';
import type {
  CategoryAnswer,
  CheckAnswer,
  ClassifyInput,
  JevAnswers,
} from './types.js';

function haystack(input: ClassifyInput): string {
  return [
    input.from,
    input.subject ?? '',
    input.extractedText ?? '',
    input.text ?? '',
  ]
    .join('\n')
    .toLowerCase();
}

function hit(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function categoryFrom(text: string): CategoryId {
  if (
    hit(text, [
      /\bcharged\b/,
      /\bcharge[ds]?\b/,
      /\binvoice\b/,
      /\brefund\b/,
      /\bpayment\b/,
      /\bbilling\b/,
    ])
  ) {
    return 'billing';
  }
  if (
    hit(text, [
      /\bverification code\b/,
      /\bone[- ]time\b/,
      /\botp\b/,
      /\bconfirm (your )?account\b/,
      /\bsign[- ]?in code\b/,
    ]) ||
    (/\bcode is\b/.test(text) && /\b\d{4,8}\b/.test(text))
  ) {
    return 'otp';
  }
  if (
    hit(text, [
      /\bnewsletter\b/,
      /\bunsubscribe\b/,
      /\bweekly digest\b/,
      /\bpromotional\b/,
    ])
  ) {
    return 'newsletter';
  }
  if (
    hit(text, [
      /\bquote request\b/,
      /\brequest (a )?demo\b/,
      /\bpricing\b/,
      /\bbuy(ing)? interest\b/,
    ])
  ) {
    return 'sales';
  }
  if (
    hit(text, [
      /\bbug report\b/,
      /\btechnical (problem|issue)\b/,
      /\btroubleshoot/,
      /\bhelp (me|request)\b/,
    ])
  ) {
    return 'support';
  }
  return 'other';
}

function spamFrom(text: string): CheckAnswer {
  const phishing = hit(text, [
    /\bverify (your )?(password|account|credit card)\b/,
    /\baccount (will be )?locked\b/,
    /\burgent:.*confirm/,
    /\bclick (here|immediately)\b.*\b(password|account|verify)\b/,
    /\bpaypa1\b/,
    /\bunusual activity\b.*\bclick\b/,
  ]);
  return phishing
    ? { probability: 1, verdict: 'yes' }
    : { probability: 0, verdict: 'no' };
}

function urgentFrom(text: string): CheckAnswer {
  const urgent = hit(text, [
    /\basap\b/,
    /\burgent\b/,
    /\bimmediately\b/,
    /\bright away\b/,
    /\bdeadline\b/,
  ]);
  return urgent
    ? { probability: 1, verdict: 'yes' }
    : { probability: 0, verdict: 'no' };
}

function needsHumanFrom(
  text: string,
  category: CategoryId,
  urgent: CheckAnswer,
): CheckAnswer {
  const explicit = hit(text, [
    /\brefund\b/,
    /\bcomplaint\b/,
    /\bdispute\b/,
    /\bcharged twice\b/,
    /\blegal\b/,
    /\bpolicy\b/,
  ]);
  const yes = explicit || (category === 'billing' && urgent.verdict === 'yes');
  return yes
    ? { probability: 1, verdict: 'yes' }
    : { probability: 0, verdict: 'no' };
}

function autoFrom(input: ClassifyInput, text: string): CheckAnswer {
  const header = (input.autoSubmitted ?? '').trim().toLowerCase();
  if (
    header === 'auto-replied' ||
    header === 'auto-generated' ||
    header === 'auto-notified'
  ) {
    return { probability: 1, verdict: 'yes' };
  }

  const bounceOrOoo = hit(text, [
    /\bmailer-daemon\b/,
    /\bundelivered mail\b/,
    /\bdelivery[- ]failure\b/,
    /\bcould not be delivered\b/,
    /\bout of (the )?office\b/,
    /\bautomatic reply\b/,
  ]);
  return bounceOrOoo
    ? { probability: 1, verdict: 'yes' }
    : { probability: 0, verdict: 'no' };
}

function categoryAnswer(chosen: CategoryId): CategoryAnswer {
  const probabilities = {
    billing: 0,
    support: 0,
    sales: 0,
    otp: 0,
    newsletter: 0,
    other: 0,
  } satisfies Record<CategoryId, number>;
  probabilities[chosen] = 1;
  return {
    chosen,
    probabilities,
    confidence: 1,
    verdict: 'act',
  };
}

/** Deterministic rules path — always returns the design §4 five-key shape. */
export function classifyWithRules(input: ClassifyInput): JevAnswers {
  const text = haystack(input);
  const category = categoryFrom(text);
  const spam = spamFrom(text);
  const urgent = urgentFrom(text);
  const needsHuman = needsHumanFrom(text, category, urgent);
  const auto = autoFrom(input, text);

  return {
    source: 'rules',
    category: categoryAnswer(category),
    spam,
    urgent,
    needsHuman,
    auto,
  };
}
