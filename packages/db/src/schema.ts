import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});
const vector384 = customType<{ data: number[] | null; driverData: string | null }>({
  dataType() { return 'vector(384)'; },
  toDriver(value) { return value === null ? null : `[${value.join(',')}]`; },
  fromDriver(value) { return value === null ? null : String(value).slice(1, -1).split(',').map(Number); },
});

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .defaultNow()
  .notNull();

export const domainStatus = pgEnum('domain_status', ['pending', 'verified', 'failed']);
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);
export const draftStatus = pgEnum('draft_status', ['draft', 'scheduled', 'sending', 'sent', 'failed']);
export const senderRuleAction = pgEnum('sender_rule_action', ['allow', 'block']);
export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'delivering',
  'delivered',
  'failed',
]);

export const pods = pgTable('pods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt,
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    podId: text('pod_id')
      .notNull()
      .references(() => pods.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY[]::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('api_keys_prefix_unique').on(table.prefix),
    index('api_keys_pod_id_idx').on(table.podId),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    podId: text('pod_id')
      .notNull()
      .references(() => pods.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('idempotency_keys_pod_key_unique').on(table.podId, table.key),
    index('idempotency_keys_created_at_idx').on(table.createdAt),
  ],
);

export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey(),
    podId: text('pod_id')
      .notNull()
      .references(() => pods.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    status: domainStatus('status').notNull().default('pending'),
    dkimPrivateKey: text('dkim_private_key'),
    dnsRecords: jsonb('dns_records').$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (table) => [
    uniqueIndex('domains_domain_unique').on(table.domain),
    index('domains_pod_id_idx').on(table.podId),
  ],
);

export const inboxes = pgTable(
  'inboxes',
  {
    id: text('id').primaryKey(),
    podId: text('pod_id')
      .notNull()
      .references(() => pods.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    domain: text('domain').notNull(),
    address: text('address').notNull(),
    displayName: text('display_name'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    clientId: text('client_id'),
    createdAt,
  },
  (table) => [
    uniqueIndex('inboxes_address_unique').on(table.address),
    uniqueIndex('inboxes_client_id_unique').on(table.clientId),
    uniqueIndex('inboxes_pod_username_domain_unique').on(table.podId, table.username, table.domain),
    index('inboxes_pod_id_idx').on(table.podId),
  ],
);

export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(),
    inboxId: text('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    subjectNormalized: text('subject_normalized').notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }).notNull(),
    messageCount: integer('message_count').notNull().default(0),
    labels: text('labels').array().notNull().default(sql`ARRAY[]::text[]`),
    preview: text('preview'),
    createdAt,
  },
  (table) => [
    index('threads_inbox_last_message_idx').on(table.inboxId, table.lastMessageAt.desc()),
    index('threads_labels_gin_idx').using('gin', table.labels),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    inboxId: text('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    messageIdHeader: text('message_id_header').notNull(),
    inReplyTo: text('in_reply_to'),
    references: text('references').array().notNull().default(sql`ARRAY[]::text[]`),
    direction: messageDirection('direction').notNull(),
    from: text('from').notNull(),
    to: text('to').array().notNull(),
    cc: text('cc').array().notNull().default(sql`ARRAY[]::text[]`),
    bcc: text('bcc').array().notNull().default(sql`ARRAY[]::text[]`),
    subject: text('subject'),
    text: text('text'),
    html: text('html'),
    extractedText: text('extracted_text'),
    labels: text('labels').array().notNull().default(sql`ARRAY[]::text[]`),
    rawObjectKey: text('raw_object_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    hopCount: integer('hop_count').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, coalesce(subject, '') || ' ' || coalesce(text, '') || ' ' || coalesce(extracted_text, ''))`,
    ),
    embedding: vector384('embedding'),
    createdAt,
  },
  (table) => [
    uniqueIndex('messages_inbox_message_id_header_unique').on(
      table.inboxId,
      table.messageIdHeader,
    ),
    index('messages_inbox_received_idx').on(table.inboxId, table.receivedAt.desc()),
    index('messages_thread_id_idx').on(table.threadId),
    index('messages_labels_gin_idx').using('gin', table.labels),
    index('messages_search_gin_idx').using('gin', table.search),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    objectKey: text('object_key').notNull(),
    contentId: text('content_id'),
    createdAt,
  },
  (table) => [index('attachments_message_id_idx').on(table.messageId)],
);

export const drafts = pgTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    inboxId: text('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    to: text('to').array().notNull().default(sql`ARRAY[]::text[]`),
    cc: text('cc').array().notNull().default(sql`ARRAY[]::text[]`),
    subject: text('subject'),
    text: text('text'),
    html: text('html'),
    sendAt: timestamp('send_at', { withTimezone: true, mode: 'date' }),
    status: draftStatus('status').notNull().default('draft'),
    createdAt,
  },
  (table) => [index('drafts_inbox_id_idx').on(table.inboxId)],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    podId: text('pod_id')
      .notNull()
      .references(() => pods.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    eventTypes: text('event_types').array().notNull(),
    inboxIds: text('inbox_ids').array(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt,
  },
  (table) => [index('webhooks_pod_id_idx').on(table.podId)],
);

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    podId: text('pod_id')
      .notNull()
      .references(() => pods.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt,
  },
  (table) => [index('events_pod_created_idx').on(table.podId, table.createdAt.desc())],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    index('webhook_deliveries_webhook_id_idx').on(table.webhookId),
    index('webhook_deliveries_retry_idx').on(table.status, table.nextRetryAt),
  ],
);

export const senderRules = pgTable(
  'sender_rules',
  {
    id: text('id').primaryKey(),
    podId: text('pod_id')
      .notNull()
      .references(() => pods.id, { onDelete: 'cascade' }),
    inboxId: text('inbox_id').references(() => inboxes.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    action: senderRuleAction('action').notNull(),
    createdAt,
  },
  (table) => [index('sender_rules_pod_inbox_idx').on(table.podId, table.inboxId)],
);

export const jevDecisions = pgTable(
  'jev_decisions',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt,
  },
  (table) => [index('jev_decisions_message_id_idx').on(table.messageId)],
);

export type Pod = typeof pods.$inferSelect;
export type Inbox = typeof inboxes.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
