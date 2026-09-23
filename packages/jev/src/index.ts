export { classify, type ClassifyOptions } from './classify.js';
export {
  JevCircuitBreaker,
  sharedJevCircuitBreaker,
} from './circuit-breaker.js';
export { createJevFetch, createTypeSafeClient } from './client.js';
export { classifyWithRules } from './rules.js';
export {
  AUTO_ACT_ABOVE,
  AUTO_REVIEW_ABOVE,
  BATCH_ACT_ABOVE,
  BATCH_REVIEW_ABOVE,
  CATEGORY_ACT_ABOVE,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  CATEGORY_REVIEW_ABOVE,
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_FAILURE_WINDOW_MS,
  JEV_TIMEOUT_MS,
  NEEDS_HUMAN_ACT_ABOVE,
  NEEDS_HUMAN_REVIEW_ABOVE,
  SPAM_ACT_ABOVE,
  SPAM_REVIEW_ABOVE,
  STATE_BODY_MAX_CHARS,
  URGENT_ACT_ABOVE,
  URGENT_REVIEW_ABOVE,
  type CategoryId,
} from './thresholds.js';
export {
  buildClassifyState,
  labelsFromAnswers,
  rederiveCheckVerdict,
  rederiveClassifyVerdict,
  type CategoryAnswer,
  type CheckAnswer,
  type CheckVerdict,
  type ClassifyInput,
  type ClassifyResult,
  type ClassifySource,
  type ClassifyVerdict,
  type JevAnswers,
} from './types.js';
