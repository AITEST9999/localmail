export const systemLabels = ['inbox', 'sent', 'draft', 'unread', 'spam', 'trash'] as const;

export type SystemLabel = (typeof systemLabels)[number];

export {
  AUTO_SUBMITTED_SHORT_CIRCUIT,
  headerString,
  isAutoSubmittedShortCircuit,
  type AutoSubmittedShortCircuit,
} from './auto-submitted.js';
export { decodeEncryptionKey, decryptSecret, encryptSecret } from './crypto.js';
export {
  allowAllRecipientPolicy,
  noopMessageEventPublisher,
  type InboxRecipient,
  type InboundIngestOverrides,
  type InboundRepository,
  type MessageEvent,
  type MessageEventPublisher,
  type MessageLabeledEvent,
  type MessageReceivedEvent,
  type MessageSentEvent,
  type ObjectStore,
  type RawObjectReader,
  type PersistInboundMessage,
  type PersistedInboundMessage,
  type RecipientDirectory,
  type RecipientPolicy,
  type StoredAttachment,
  type ThreadRecord,
} from './inbound-contracts.js';
export {
  createInboundIngestor,
  type CreateInboundIngestorOptions,
  type InboundIngestOptions,
  type InboundIngestor,
} from './inbound.js';
export {
  DEFAULT_MAX_HOPS,
  HopLimitExceededError,
  nextHopCount,
} from './hop-count.js';
export {
  createS3ObjectStore,
  type S3ObjectStoreOptions,
} from './object-store.js';
export {
  CLASSIFY_SKIP_LABEL,
  createSenderRulesRecipientPolicy,
  evaluateSenderRules,
  extractEmailAddress,
  matchSenderPattern,
  shouldSkipClassify,
  type SenderBlockMode,
  type SenderRule,
  type SenderRuleAction,
  type SenderRuleLoader,
  type SenderRulesDecision,
} from './sender-rules.js';
export {
  getThreadingMessageIds,
  normalizeSubject,
  resolveThread,
  type MessageHeaderValue,
  type ThreadingMessage,
  type ThreadLookup,
  type ThreadLookupQuery,
  type ThreadResolution,
} from './threading.js';
