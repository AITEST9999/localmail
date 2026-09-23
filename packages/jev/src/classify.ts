import { choice, noul, type TypeSafeClient } from '@typesafe-ai/sdk';

import {
  sharedJevCircuitBreaker,
  type JevCircuitBreaker,
} from './circuit-breaker.js';
import { createTypeSafeClient } from './client.js';
import { classifyWithRules } from './rules.js';
import {
  AUTO_ACT_ABOVE,
  AUTO_REVIEW_ABOVE,
  CATEGORY_ACT_ABOVE,
  CATEGORY_OPTIONS,
  CATEGORY_REVIEW_ABOVE,
  JEV_TIMEOUT_MS,
  NEEDS_HUMAN_ACT_ABOVE,
  NEEDS_HUMAN_REVIEW_ABOVE,
  NO_AUTO,
  NO_NEEDS_HUMAN,
  NO_SPAM,
  NO_URGENT,
  QUESTION_AUTO,
  QUESTION_CATEGORY,
  QUESTION_NEEDS_HUMAN,
  QUESTION_SPAM,
  QUESTION_URGENT,
  SPAM_ACT_ABOVE,
  SPAM_REVIEW_ABOVE,
  URGENT_ACT_ABOVE,
  URGENT_REVIEW_ABOVE,
  YES_AUTO,
  YES_NEEDS_HUMAN,
  YES_SPAM,
  YES_URGENT,
  type CategoryId,
} from './thresholds.js';
import {
  buildClassifyState,
  labelsFromAnswers,
  rederiveCheckVerdict,
  rederiveClassifyVerdict,
  type ClassifyInput,
  type ClassifyResult,
  type JevAnswers,
} from './types.js';

export interface ClassifyOptions {
  /** When false, always use rules (P3-15 / design D4.4). */
  jevEnabled: boolean;
  /** Required when `jevEnabled` and the breaker is closed. */
  apiKey?: string;
  /** Inject for tests. */
  client?: TypeSafeClient;
  /** Inject for tests. */
  breaker?: JevCircuitBreaker;
  timeoutMs?: number;
}

/**
 * One classify entrypoint (PLAN D4.4): live System One batched call, or rules.
 * On timeout/error/open breaker → rules for that message.
 */
export async function classify(
  input: ClassifyInput,
  options: ClassifyOptions,
): Promise<ClassifyResult> {
  const started = Date.now();
  const breaker = options.breaker ?? sharedJevCircuitBreaker;

  if (!options.jevEnabled || breaker.isOpen()) {
    const answers = classifyWithRules(input);
    return {
      answers,
      latencyMs: Date.now() - started,
      labels: labelsFromAnswers(answers),
    };
  }

  if (!options.apiKey && !options.client) {
    const answers = classifyWithRules(input);
    return {
      answers,
      latencyMs: Date.now() - started,
      labels: labelsFromAnswers(answers),
    };
  }

  try {
    const client =
      options.client ??
      createTypeSafeClient({
        apiKey: options.apiKey!,
        timeoutMs: options.timeoutMs ?? JEV_TIMEOUT_MS,
      });
    const answers = await classifyWithJev(client, input, options.timeoutMs);
    breaker.recordSuccess();
    return {
      answers,
      latencyMs: Date.now() - started,
      labels: labelsFromAnswers(answers),
    };
  } catch {
    breaker.recordFailure();
    const answers = classifyWithRules(input);
    return {
      answers,
      latencyMs: Date.now() - started,
      labels: labelsFromAnswers(answers),
    };
  }
}

async function classifyWithJev(
  client: TypeSafeClient,
  input: ClassifyInput,
  timeoutMs = JEV_TIMEOUT_MS,
): Promise<JevAnswers> {
  const state = buildClassifyState(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { answers } = await client.systemOne(
      {
        state,
        questions: {
          category: choice(QUESTION_CATEGORY, { ...CATEGORY_OPTIONS }),
          spam: noul(QUESTION_SPAM, {
            true: YES_SPAM,
            false: NO_SPAM,
          }),
          urgent: noul(QUESTION_URGENT, {
            true: YES_URGENT,
            false: NO_URGENT,
          }),
          needsHuman: noul(QUESTION_NEEDS_HUMAN, {
            true: YES_NEEDS_HUMAN,
            false: NO_NEEDS_HUMAN,
          }),
          auto: noul(QUESTION_AUTO, {
            true: YES_AUTO,
            false: NO_AUTO,
          }),
        },
      },
      {
        signal: controller.signal,
        timeout: timeoutMs,
        // Batch uses tool defaults; per-question thresholds applied below.
        // act_above/review_above are not on systemOne RequestOptions in the SDK —
        // the API uses model defaults (~0.8/0.5); we re-derive in app code.
      },
    );

    const categoryChosen = assertCategoryId(answers.category.choice);
    const categoryConfidence = answers.category.confidence;
    const categoryProbabilities = {
      billing: answers.category.probabilities.billing ?? 0,
      support: answers.category.probabilities.support ?? 0,
      sales: answers.category.probabilities.sales ?? 0,
      otp: answers.category.probabilities.otp ?? 0,
      newsletter: answers.category.probabilities.newsletter ?? 0,
      other: answers.category.probabilities.other ?? 0,
    };

    return {
      source: 'jev',
      category: {
        chosen: categoryChosen,
        probabilities: categoryProbabilities,
        confidence: categoryConfidence,
        verdict: rederiveClassifyVerdict(
          categoryConfidence,
          CATEGORY_ACT_ABOVE,
          CATEGORY_REVIEW_ABOVE,
        ),
      },
      spam: {
        probability: answers.spam.noul,
        verdict: rederiveCheckVerdict(
          answers.spam.noul,
          SPAM_ACT_ABOVE,
          SPAM_REVIEW_ABOVE,
        ),
      },
      urgent: {
        probability: answers.urgent.noul,
        verdict: rederiveCheckVerdict(
          answers.urgent.noul,
          URGENT_ACT_ABOVE,
          URGENT_REVIEW_ABOVE,
        ),
      },
      needsHuman: {
        probability: answers.needsHuman.noul,
        verdict: rederiveCheckVerdict(
          answers.needsHuman.noul,
          NEEDS_HUMAN_ACT_ABOVE,
          NEEDS_HUMAN_REVIEW_ABOVE,
        ),
      },
      auto: {
        probability: answers.auto.noul,
        verdict: rederiveCheckVerdict(
          answers.auto.noul,
          AUTO_ACT_ABOVE,
          AUTO_REVIEW_ABOVE,
        ),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function assertCategoryId(value: string): CategoryId {
  if (value in CATEGORY_OPTIONS) return value as CategoryId;
  return 'other';
}
