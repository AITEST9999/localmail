import type { Readable } from 'node:stream';

import type { ThreadLookupQuery } from './threading.js';

export interface InboxRecipient {
  id: string;
  podId: string;
  address: string;
}

export interface RecipientDirectory {
  findByAddress(address: string): Promise<InboxRecipient | null>;
}

export interface RecipientPolicyContext {
  inbox: InboxRecipient;
  mailFrom: string | null;
  remoteAddress: string;
}

export interface InboundIngestOverrides {
  /** When set, replaces the default `inbox,unread` label set at persist time. */
  labels: string[];
  /** Durable classify-skip signal; also reflected via `skip_classify` label. */
  skipClassify: boolean;
}

export interface RecipientPolicyDecision {
  allowed: boolean;
  reason?: string;
  /**
   * When allowed under spam-label block mode, SMTP passes these overrides into
   * ingest so the message is stored as spam without a Jev classify call.
   */
  ingest?: InboundIngestOverrides;
}

/** P3-16: persisted allow/block rules via `createSenderRulesRecipientPolicy`. */
export interface RecipientPolicy {
  evaluate(
    context: RecipientPolicyContext,
  ): Promise<RecipientPolicyDecision> | RecipientPolicyDecision;
}

export const allowAllRecipientPolicy: RecipientPolicy = {
  evaluate: () => ({ allowed: true }),
};

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RawObjectReader {
  getStream(key: string): Promise<Readable>;
}

export interface ThreadRecord {
  id: string;
  labels: string[];
}

export interface StoredAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  objectKey: string;
  contentId: string | null;
}

export interface PersistInboundMessage {
  id: string;
  inbox: InboxRecipient;
  existingThread: ThreadRecord | null;
  newThreadId: string;
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  subjectNormalized: string;
  text: string | null;
  html: string | null;
  extractedText: string | null;
  preview: string | null;
  labels: string[];
  /**
   * When true, jev-classify must not enqueue/run for this message
   * (P3-16 sender-block spam mode). Durable copy also lives in `labels`
   * as `skip_classify`.
   */
  skipClassify?: boolean;
  rawObjectKey: string;
  sizeBytes: number;
  hopCount: number;
  sentAt: Date | null;
  receivedAt: Date;
  attachments: StoredAttachment[];
}

export interface PersistedInboundMessage {
  messageId: string;
  threadId: string;
}

export interface InboundRepository extends RecipientDirectory {
  lookupThread(
    inboxId: string,
    query: ThreadLookupQuery,
  ): Promise<ThreadRecord | null>;
  persistMessage(
    message: PersistInboundMessage,
  ): Promise<PersistedInboundMessage>;
}

export interface MessageReceivedEvent {
  type: 'message.received';
  podId: string;
  inboxId: string;
  threadId: string;
  messageId: string;
  /**
   * P3-17: when true, `emit()` persists the events row but skips webhook
   * deliveries, WS publish, and `jev-classify` enqueue (Auto-Submitted path).
   */
  suppressAgentTriggers?: boolean;
}

export interface MessageSentEvent {
  type: 'message.sent';
  podId: string;
  inboxId: string;
  threadId: string;
  messageId: string;
}

export interface MessageLabeledEvent {
  type: 'message.labeled';
  podId: string;
  inboxId: string;
  threadId: string;
  messageId: string;
  labels: string[];
}

export type MessageEvent =
  | MessageReceivedEvent
  | MessageSentEvent
  | MessageLabeledEvent;

/** P2-11 replaces this boundary with the durable event/webhook publisher. */
export interface MessageEventPublisher {
  emit(event: MessageEvent): Promise<void> | void;
}

export const noopMessageEventPublisher: MessageEventPublisher = {
  emit: () => undefined,
};
