import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  InboundRepository,
  InboxRecipient,
  PersistInboundMessage,
  PersistedInboundMessage,
  StoredAttachment,
  ThreadLookupQuery,
  ThreadRecord,
} from '@localmail/core';
import type { PageCursor, SearchCursor } from './pagination.js';

import {
  apiKeys,
  attachments,
  createDrizzleInboundRepository,
  createId,
  drafts,
  domains,
  idempotencyKeys,
  inboxes,
  messages,
  pods,
  threads,
  webhookDeliveries,
  webhooks,
  type Database,
} from '@localmail/db';

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;
export type InboxRow = typeof inboxes.$inferSelect;
// Embeddings are added by the asynchronous worker; keep the field optional for
// existing read projections and in-memory stores while the DB column is nullable.
export type MessageRow = Omit<typeof messages.$inferSelect, 'embedding'> & { embedding?: number[] | null };
export type ThreadRow = typeof threads.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type PodRow = typeof pods.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;

export interface MessageListRow {
  message: MessageRow;
  sortAt: Date;
}
export interface SearchMessageRow { message: MessageRow; rank: number }

export interface ListThreadsQuery {
  labels: string[];
  before?: Date;
  after?: Date;
  limit: number;
  cursor?: PageCursor;
}

export interface ListMessagesQuery extends ListThreadsQuery {
  sender?: string;
  unread?: boolean;
  direction?: 'inbound' | 'outbound';
}

export interface UpdateMessageLabelsRecord {
  addLabels: string[];
  removeLabels: string[];
}

export interface MessageForSend {
  inbox: InboxRow;
  message: MessageRow;
}

export interface PersistOutboundMessage {
  id: string;
  inboxId: string;
  existingThreadId: string | null;
  newThreadId: string;
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  subjectNormalized: string;
  text: string | null;
  html: string | null;
  labels: string[];
  rawObjectKey: string;
  sizeBytes: number;
  hopCount: number;
  sentAt: Date;
  preview: string | null;
  attachments: StoredAttachment[];
}

export interface CreateInboxRecord {
  id: string;
  podId: string;
  username: string;
  domain: string;
  address: string;
  displayName: string | null;
  metadata: Record<string, unknown>;
  clientId: string | null;
}

export interface UpdateInboxRecord {
  displayName?: string | null;
  metadata?: Record<string, unknown>;
}

export interface InboxCursor {
  createdAt: Date;
  id: string;
}

export interface IdempotencyRecord {
  podId: string;
  key: string;
  endpoint: string;
  requestHash: string;
  responseStatus: number;
  responseBody: Record<string, unknown>;
}

export interface CreateWebhookRecord {
  id: string;
  podId: string;
  url: string;
  secretCiphertext: string;
  eventTypes: string[];
  inboxIds: string[] | null;
  enabled: boolean;
}

export interface UpdateWebhookRecord {
  url?: string;
  eventTypes?: string[];
  inboxIds?: string[] | null;
  enabled?: boolean;
}

export interface DraftCursor {
  createdAt: Date;
  id: string;
}

export interface CreateDraftRecord {
  id: string;
  inboxId: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  sendAt: Date | null;
  status: 'draft' | 'scheduled';
}

export interface UpdateDraftRecord {
  to?: string[];
  cc?: string[];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  sendAt?: Date | null;
  status?: 'draft' | 'scheduled';
}

export interface DraftSendTarget {
  draft: DraftRow;
  inbox: InboxRow;
}

export interface ApiStore extends InboundRepository {
  createDomain(record: { id: string; podId: string; domain: string; status: 'pending'; dkimPrivateKey: string; dnsRecords: Record<string, unknown> }): Promise<DomainRow>;
  listDomains(podId: string, limit: number, cursor?: InboxCursor): Promise<DomainRow[]>;
  findDomainById(podId: string, id: string): Promise<DomainRow | null>;
  updateDomainStatus(podId: string, id: string, status: 'verified' | 'failed'): Promise<DomainRow | null>;
  deleteDomain(podId: string, id: string): Promise<boolean>;
  findVerifiedDomain(podId: string, domain: string): Promise<DomainRow | null>;
  createPod(record: { id: string; name: string }): Promise<PodRow>;
  findPodById(id: string): Promise<PodRow | null>;
  createApiKey(record: { id: string; podId: string; prefix: string; hash: string; scopes: string[] }): Promise<ApiKeyRow>;
  listApiKeys(podId: string, limit: number, cursor?: InboxCursor): Promise<ApiKeyRow[]>;
  countActiveApiKeys(podId: string): Promise<number>;
  revokeApiKey(podId: string, id: string): Promise<boolean>;
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
  touchApiKey(id: string): Promise<void>;
  findIdempotencyRecord(
    podId: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
  findInboxByClientId(
    podId: string,
    clientId: string,
  ): Promise<InboxRow | null>;
  createInbox(record: CreateInboxRecord): Promise<InboxRow | null>;
  listInboxes(
    podId: string,
    limit: number,
    cursor?: InboxCursor,
    address?: string,
  ): Promise<InboxRow[]>;
  findInboxById(podId: string, id: string): Promise<InboxRow | null>;
  updateInbox(
    podId: string,
    id: string,
    updates: UpdateInboxRecord,
  ): Promise<InboxRow | null>;
  deleteInbox(podId: string, id: string): Promise<boolean>;
  findMessageForSend(
    podId: string,
    inboxId: string,
    messageId: string,
  ): Promise<MessageForSend | null>;
  findLocalInboxesByAddresses(
    addresses: string[],
  ): Promise<InboxRecipient[]>;
  persistOutboundMessage(
    message: PersistOutboundMessage,
  ): Promise<MessageRow>;
  listThreads(
    podId: string,
    inboxId: string,
    query: ListThreadsQuery,
  ): Promise<ThreadRow[]>;
  findThreadById(
    podId: string,
    inboxId: string,
    threadId: string,
  ): Promise<ThreadRow | null>;
  listThreadMessages(
    podId: string,
    inboxId: string,
    threadId: string,
  ): Promise<MessageRow[]>;
  listMessages(
    podId: string,
    inboxId: string,
    query: ListMessagesQuery,
  ): Promise<MessageListRow[]>;
  searchMessages(
    podId: string,
    query: string,
    inboxId: string | undefined,
    limit: number,
    cursor?: SearchCursor,
  ): Promise<SearchMessageRow[]>;
  searchMessagesSemantic(
    podId: string, queryVector: number[], inboxId: string | undefined, limit: number, cursor?: SearchCursor,
  ): Promise<SearchMessageRow[]>;
  findMessageById(
    podId: string,
    inboxId: string,
    messageId: string,
  ): Promise<MessageRow | null>;
  findAttachmentById(
    podId: string,
    inboxId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentRow | null>;
  updateMessageLabels(
    podId: string,
    inboxId: string,
    messageId: string,
    updates: UpdateMessageLabelsRecord,
  ): Promise<MessageRow | null>;
  createWebhook(record: CreateWebhookRecord): Promise<WebhookRow>;
  listWebhooks(podId: string): Promise<WebhookRow[]>;
  findWebhookById(podId: string, id: string): Promise<WebhookRow | null>;
  updateWebhook(
    podId: string,
    id: string,
    updates: UpdateWebhookRecord,
  ): Promise<WebhookRow | null>;
  deleteWebhook(podId: string, id: string): Promise<boolean>;
  listWebhookDeliveries(
    podId: string,
    webhookId: string,
    limit: number,
  ): Promise<WebhookDeliveryRow[]>;
  createDraft(record: CreateDraftRecord): Promise<DraftRow>;
  listDrafts(
    podId: string,
    inboxId: string,
    limit: number,
    cursor?: DraftCursor,
    status?: DraftRow['status'],
  ): Promise<DraftRow[]>;
  findDraftById(
    podId: string,
    inboxId: string,
    draftId: string,
  ): Promise<DraftRow | null>;
  updateDraft(
    podId: string,
    inboxId: string,
    draftId: string,
    updates: UpdateDraftRecord,
  ): Promise<DraftRow | null>;
  deleteDraft(
    podId: string,
    inboxId: string,
    draftId: string,
  ): Promise<boolean>;
  claimDraftForSend(
    podId: string,
    inboxId: string,
    draftId: string,
  ): Promise<DraftSendTarget | null>;
  listDueDraftIds(limit: number): Promise<string[]>;
  claimScheduledDraft(draftId: string): Promise<DraftSendTarget | null>;
  markDraftStatus(
    draftId: string,
    status: DraftRow['status'],
  ): Promise<void>;
}

export function createDrizzleApiStore(db: Database): ApiStore {
  const inboundRepository = createDrizzleInboundRepository(db);
  return {
    async createPod(record) {
      const [row] = await db.insert(pods).values(record).returning();
      if (!row) throw new Error('Pod insert returned no row.');
      return row;
    },

    async createDomain(record) {
      const [row] = await db.insert(domains).values(record).returning();
      if (!row) throw new Error('Domain insert returned no row.');
      return row;
    },
    async listDomains(podId, limit, cursor) {
      const cursorFilter = cursor ? or(lt(domains.createdAt, cursor.createdAt), and(eq(domains.createdAt, cursor.createdAt), lt(domains.id, cursor.id))) : undefined;
      return db.select().from(domains).where(and(eq(domains.podId, podId), cursorFilter)).orderBy(desc(domains.createdAt), desc(domains.id)).limit(limit);
    },
    async findDomainById(podId, id) {
      const [row] = await db.select().from(domains).where(and(eq(domains.podId, podId), eq(domains.id, id))).limit(1); return row ?? null;
    },
    async updateDomainStatus(podId, id, status) {
      const [row] = await db.update(domains).set({ status }).where(and(eq(domains.podId, podId), eq(domains.id, id))).returning(); return row ?? null;
    },
    async deleteDomain(podId, id) {
      const rows = await db.delete(domains).where(and(eq(domains.podId, podId), eq(domains.id, id))).returning({ id: domains.id }); return rows.length > 0;
    },
    async findVerifiedDomain(podId, domain) {
      const [row] = await db.select().from(domains).where(and(eq(domains.podId, podId), eq(domains.domain, domain), eq(domains.status, 'verified'))).limit(1); return row ?? null;
    },

    async findPodById(id) {
      const [row] = await db.select().from(pods).where(eq(pods.id, id)).limit(1);
      return row ?? null;
    },

    async createApiKey(record) {
      const [row] = await db.insert(apiKeys).values(record).returning();
      if (!row) throw new Error('API key insert returned no row.');
      return row;
    },

    async listApiKeys(podId, limit, cursor) {
      const cursorFilter = cursor
        ? or(lt(apiKeys.createdAt, cursor.createdAt), and(eq(apiKeys.createdAt, cursor.createdAt), lt(apiKeys.id, cursor.id)))
        : undefined;
      return db.select().from(apiKeys)
        .where(and(eq(apiKeys.podId, podId), cursorFilter))
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id)).limit(limit);
    },

    async countActiveApiKeys(podId) {
      const rows = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.podId, podId), isNull(apiKeys.revokedAt)));
      return rows.length;
    },

    async revokeApiKey(podId, id) {
      const rows = await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.podId, podId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
      return rows.length > 0;
    },

    async findApiKeyByPrefix(prefix) {
      const [row] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.prefix, prefix))
        .limit(1);
      return row ?? null;
    },

    async touchApiKey(id) {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, id));
    },

    async findIdempotencyRecord(podId, key) {
      // See docs/api-contract-phase1.md §4: Phase 1 intentionally has no in-flight claim state.
      const [row] = await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.podId, podId), eq(idempotencyKeys.key, key)),
        )
        .limit(1);
      return row ?? null;
    },

    async saveIdempotencyRecord(record) {
      await db
        .insert(idempotencyKeys)
        .values({ id: createId('idem'), ...record })
        .onConflictDoNothing({
          target: [idempotencyKeys.podId, idempotencyKeys.key],
        });
    },

    async findInboxByClientId(podId, clientId) {
      const [row] = await db
        .select()
        .from(inboxes)
        .where(and(eq(inboxes.podId, podId), eq(inboxes.clientId, clientId)))
        .limit(1);
      return row ?? null;
    },

    async createInbox(record) {
      const [row] = await db
        .insert(inboxes)
        .values(record)
        // Address, pod/username/domain, and client_id uniqueness are resolved by
        // PostgreSQL so concurrent creates cannot pass an application-side check.
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },

    async listInboxes(podId, limit, cursor, address) {
      const cursorFilter = cursor
        ? or(
            lt(inboxes.createdAt, cursor.createdAt),
            and(
              eq(inboxes.createdAt, cursor.createdAt),
              lt(inboxes.id, cursor.id),
            ),
          )
        : undefined;
      const addressFilter = address ? ilike(inboxes.address, address) : undefined;

      return db
        .select()
        .from(inboxes)
        .where(and(eq(inboxes.podId, podId), cursorFilter, addressFilter))
        .orderBy(desc(inboxes.createdAt), desc(inboxes.id))
        .limit(limit);
    },

    async findInboxById(podId, id) {
      const [row] = await db
        .select()
        .from(inboxes)
        .where(and(eq(inboxes.podId, podId), eq(inboxes.id, id)))
        .limit(1);
      return row ?? null;
    },

    async updateInbox(podId, id, updates) {
      const [row] = await db
        .update(inboxes)
        .set(updates)
        .where(and(eq(inboxes.podId, podId), eq(inboxes.id, id)))
        .returning();
      return row ?? null;
    },

    async deleteInbox(podId, id) {
      const deleted = await db
        .delete(inboxes)
        .where(and(eq(inboxes.podId, podId), eq(inboxes.id, id)))
        .returning({ id: inboxes.id });
      return deleted.length > 0;
    },

    findByAddress(address): Promise<InboxRecipient | null> {
      return inboundRepository.findByAddress(address);
    },

    lookupThread(
      inboxId: string,
      query: ThreadLookupQuery,
    ): Promise<ThreadRecord | null> {
      return inboundRepository.lookupThread(inboxId, query);
    },

    persistMessage(
      message: PersistInboundMessage,
    ): Promise<PersistedInboundMessage> {
      return inboundRepository.persistMessage(message);
    },

    async findMessageForSend(podId, inboxId, messageId) {
      const [row] = await db
        .select({ inbox: inboxes, message: messages })
        .from(messages)
        .innerJoin(inboxes, eq(messages.inboxId, inboxes.id))
        .where(
          and(
            eq(inboxes.podId, podId),
            eq(inboxes.id, inboxId),
            eq(messages.id, messageId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findLocalInboxesByAddresses(addresses) {
      if (addresses.length === 0) return [];
      return db
        .select({ id: inboxes.id, podId: inboxes.podId, address: inboxes.address })
        .from(inboxes)
        .where(inArray(inboxes.address, addresses));
    },

    async persistOutboundMessage(message) {
      return db.transaction(async (transaction) => {
        const threadId = message.existingThreadId ?? message.newThreadId;
        if (message.existingThreadId) {
          await transaction
            .update(threads)
            .set({
              lastMessageAt: message.sentAt,
              messageCount: sql`${threads.messageCount} + 1`,
              preview: message.preview,
            })
            .where(
              and(
                eq(threads.id, message.existingThreadId),
                eq(threads.inboxId, message.inboxId),
              ),
            );
        } else {
          await transaction.insert(threads).values({
            id: threadId,
            inboxId: message.inboxId,
            subjectNormalized: message.subjectNormalized,
            lastMessageAt: message.sentAt,
            messageCount: 1,
            labels: message.labels,
            preview: message.preview,
          });
        }

        const [row] = await transaction
          .insert(messages)
          .values({
            id: message.id,
            inboxId: message.inboxId,
            threadId,
            messageIdHeader: message.messageIdHeader,
            inReplyTo: message.inReplyTo,
            references: message.references,
            direction: 'outbound',
            from: message.from,
            to: message.to,
            cc: message.cc,
            bcc: message.bcc,
            subject: message.subject,
            text: message.text,
            html: message.html,
            extractedText: message.text,
            labels: message.labels,
            rawObjectKey: message.rawObjectKey,
            sizeBytes: message.sizeBytes,
            hopCount: message.hopCount,
            sentAt: message.sentAt,
          })
          .returning();
        if (!row) throw new Error('Outbound message insert returned no row.');
        if (message.attachments.length > 0) {
          await transaction.insert(attachments).values(
            message.attachments.map((attachment) => ({
              ...attachment,
              messageId: message.id,
            })),
          );
        }
        return row;
      });
    },

    async listThreads(podId, inboxId, query) {
      const conditions: SQL[] = [
        eq(inboxes.podId, podId),
        eq(threads.inboxId, inboxId),
      ];
      if (query.labels.length > 0)
        conditions.push(arrayContains(threads.labels, query.labels));
      if (query.before)
        conditions.push(lt(threads.lastMessageAt, query.before));
      if (query.after)
        conditions.push(gt(threads.lastMessageAt, query.after));
      if (query.cursor) {
        conditions.push(
          or(
            lt(threads.lastMessageAt, query.cursor.sortAt),
            and(
              eq(threads.lastMessageAt, query.cursor.sortAt),
              lt(threads.id, query.cursor.id),
            ),
          )!,
        );
      }
      return db
        .select({
          id: threads.id,
          inboxId: threads.inboxId,
          subjectNormalized: threads.subjectNormalized,
          lastMessageAt: threads.lastMessageAt,
          messageCount: threads.messageCount,
          labels: threads.labels,
          preview: threads.preview,
          createdAt: threads.createdAt,
        })
        .from(threads)
        .innerJoin(inboxes, eq(threads.inboxId, inboxes.id))
        .where(and(...conditions))
        .orderBy(desc(threads.lastMessageAt), desc(threads.id))
        .limit(query.limit);
    },

    async findThreadById(podId, inboxId, threadId) {
      const [row] = await db
        .select({
          id: threads.id,
          inboxId: threads.inboxId,
          subjectNormalized: threads.subjectNormalized,
          lastMessageAt: threads.lastMessageAt,
          messageCount: threads.messageCount,
          labels: threads.labels,
          preview: threads.preview,
          createdAt: threads.createdAt,
        })
        .from(threads)
        .innerJoin(inboxes, eq(threads.inboxId, inboxes.id))
        .where(
          and(
            eq(inboxes.podId, podId),
            eq(threads.inboxId, inboxId),
            eq(threads.id, threadId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listThreadMessages(podId, inboxId, threadId) {
      return db
        .select({
          id: messages.id,
          inboxId: messages.inboxId,
          threadId: messages.threadId,
          messageIdHeader: messages.messageIdHeader,
          inReplyTo: messages.inReplyTo,
          references: messages.references,
          direction: messages.direction,
          from: messages.from,
          to: messages.to,
          cc: messages.cc,
          bcc: messages.bcc,
          subject: messages.subject,
          text: messages.text,
          html: messages.html,
          extractedText: messages.extractedText,
          labels: messages.labels,
          rawObjectKey: messages.rawObjectKey,
          sizeBytes: messages.sizeBytes,
          hopCount: messages.hopCount,
          sentAt: messages.sentAt,
          receivedAt: messages.receivedAt,
          search: messages.search,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(inboxes, eq(messages.inboxId, inboxes.id))
        .where(
          and(
            eq(inboxes.podId, podId),
            eq(messages.inboxId, inboxId),
            eq(messages.threadId, threadId),
          ),
        )
        .orderBy(
          asc(sql`coalesce(${messages.receivedAt}, ${messages.sentAt}, ${messages.createdAt})`),
          asc(messages.id),
        );
    },

    async listMessages(podId, inboxId, query) {
      // Raw SQL expressions do not inherit Drizzle's timestamp decoder. Map the
      // coalesced value explicitly so pagination always receives a real Date.
      const sortAt = sql<Date>`coalesce(${messages.receivedAt}, ${messages.sentAt}, ${messages.createdAt})`.mapWith(
        messages.createdAt,
      );
      const conditions: SQL[] = [
        eq(inboxes.podId, podId),
        eq(messages.inboxId, inboxId),
      ];
      if (query.labels.length > 0)
        conditions.push(arrayContains(messages.labels, query.labels));
      // `sortAt` is a raw SQL expression, not a typed timestamp column, so
      // Drizzle's Date -> bind-parameter encoder doesn't apply to it (only
      // `mapWith`'s decoder does). Comparing against it needs the same
      // pre-serialized ::timestamptz cast the cursor comparison uses below.
      if (query.before)
        conditions.push(sql`${sortAt} < ${query.before.toISOString()}::timestamptz`);
      if (query.after)
        conditions.push(sql`${sortAt} > ${query.after.toISOString()}::timestamptz`);
      if (query.sender) conditions.push(ilike(messages.from, `%${query.sender}%`));
      if (query.direction) conditions.push(eq(messages.direction, query.direction));
      if (query.unread !== undefined) {
        const unread = arrayContains(messages.labels, ['unread']);
        conditions.push(query.unread ? unread : not(unread));
      }
      if (query.cursor) {
        // Keep the cursor comparison as one PostgreSQL row-value predicate.
        // Besides matching the contract exactly, this avoids applying the
        // selected expression's result decoder to bound cursor parameters.
        conditions.push(
          sql`(${sortAt}, ${messages.id}) < (${query.cursor.sortAt.toISOString()}::timestamptz, ${query.cursor.id})`,
        );
      }
      return db
        .select({ message: messages, sortAt })
        .from(messages)
        .innerJoin(inboxes, eq(messages.inboxId, inboxes.id))
        .where(and(...conditions))
        .orderBy(desc(sortAt), desc(messages.id))
        .limit(query.limit);
    },

    async searchMessages(podId, query, inboxId, limit, cursor) {
      const rank = sql<number>`ts_rank(${messages.search}, plainto_tsquery('english', ${query}))`;
      const conditions: SQL[] = [
        eq(inboxes.podId, podId),
        sql`${messages.search} @@ plainto_tsquery('english', ${query})`,
      ];
      if (inboxId) conditions.push(eq(messages.inboxId, inboxId));
      if (cursor) conditions.push(or(sql`${rank} < ${cursor.rank}`, and(sql`${rank} = ${cursor.rank}`, lt(messages.id, cursor.id)))!);
      const rows = await db.select({ message: messages, rank }).from(messages).innerJoin(inboxes, eq(messages.inboxId, inboxes.id)).where(and(...conditions)).orderBy(desc(rank), desc(messages.id)).limit(limit);
      return rows;
    },

    async searchMessagesSemantic(podId, queryVector, inboxId, limit, cursor) {
      const vector = sql`${`[${queryVector.join(',')}]`}::vector`;
      const distance = sql<number>`(${messages.embedding} <=> ${vector})`;
      const rank = sql<number>`(1 - ${distance})`;
      const conditions: SQL[] = [eq(inboxes.podId, podId), isNotNull(messages.embedding)];
      if (inboxId) conditions.push(eq(messages.inboxId, inboxId));
      if (cursor) conditions.push(or(sql`${rank} < ${cursor.rank}`, and(sql`${rank} = ${cursor.rank}`, lt(messages.id, cursor.id)))!);
      return db.select({ message: messages, rank }).from(messages).innerJoin(inboxes, eq(messages.inboxId, inboxes.id)).where(and(...conditions)).orderBy(desc(rank), desc(messages.id)).limit(limit);
    },

    async findMessageById(podId, inboxId, messageId) {
      const [row] = await db
        .select({
          id: messages.id,
          inboxId: messages.inboxId,
          threadId: messages.threadId,
          messageIdHeader: messages.messageIdHeader,
          inReplyTo: messages.inReplyTo,
          references: messages.references,
          direction: messages.direction,
          from: messages.from,
          to: messages.to,
          cc: messages.cc,
          bcc: messages.bcc,
          subject: messages.subject,
          text: messages.text,
          html: messages.html,
          extractedText: messages.extractedText,
          labels: messages.labels,
          rawObjectKey: messages.rawObjectKey,
          sizeBytes: messages.sizeBytes,
          hopCount: messages.hopCount,
          sentAt: messages.sentAt,
          receivedAt: messages.receivedAt,
          search: messages.search,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(inboxes, eq(messages.inboxId, inboxes.id))
        .where(
          and(
            eq(inboxes.podId, podId),
            eq(messages.inboxId, inboxId),
            eq(messages.id, messageId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findAttachmentById(podId, inboxId, messageId, attachmentId) {
      const [row] = await db
        .select({
          id: attachments.id,
          messageId: attachments.messageId,
          filename: attachments.filename,
          contentType: attachments.contentType,
          size: attachments.size,
          objectKey: attachments.objectKey,
          contentId: attachments.contentId,
          createdAt: attachments.createdAt,
        })
        .from(attachments)
        .innerJoin(messages, eq(attachments.messageId, messages.id))
        .innerJoin(inboxes, eq(messages.inboxId, inboxes.id))
        .where(
          and(
            eq(inboxes.podId, podId),
            eq(messages.inboxId, inboxId),
            eq(messages.id, messageId),
            eq(attachments.id, attachmentId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async updateMessageLabels(podId, inboxId, messageId, updates) {
      return db.transaction(async (transaction) => {
        const [existing] = await transaction
          .select({ id: messages.id, threadId: messages.threadId, labels: messages.labels })
          .from(messages)
          .innerJoin(inboxes, eq(messages.inboxId, inboxes.id))
          .where(
            and(
              eq(inboxes.podId, podId),
              eq(messages.inboxId, inboxId),
              eq(messages.id, messageId),
            ),
          )
          .limit(1);
        if (!existing) return null;

        const nextLabels = applyLabelUpdates(existing.labels, updates);
        const [row] = await transaction
          .update(messages)
          .set({ labels: nextLabels })
          .where(eq(messages.id, messageId))
          .returning();
        if (!row) return null;

        const threadMessages = await transaction
          .select({ labels: messages.labels })
          .from(messages)
          .where(eq(messages.threadId, existing.threadId));
        const threadLabels = [
          ...new Set(threadMessages.flatMap((message) => message.labels)),
        ];
        await transaction
          .update(threads)
          .set({ labels: threadLabels })
          .where(eq(threads.id, existing.threadId));

        return row;
      });
    },

    async createWebhook(record) {
      const [row] = await db
        .insert(webhooks)
        .values({
          id: record.id,
          podId: record.podId,
          url: record.url,
          secret: record.secretCiphertext,
          eventTypes: record.eventTypes,
          inboxIds: record.inboxIds,
          enabled: record.enabled,
        })
        .returning();
      if (!row) throw new Error('Failed to create webhook.');
      return row;
    },

    async listWebhooks(podId) {
      return db
        .select()
        .from(webhooks)
        .where(eq(webhooks.podId, podId))
        .orderBy(desc(webhooks.createdAt), desc(webhooks.id));
    },

    async findWebhookById(podId, id) {
      const [row] = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.podId, podId), eq(webhooks.id, id)))
        .limit(1);
      return row ?? null;
    },

    async updateWebhook(podId, id, updates) {
      const set: Partial<typeof webhooks.$inferInsert> = {};
      if (updates.url !== undefined) set.url = updates.url;
      if (updates.eventTypes !== undefined) set.eventTypes = updates.eventTypes;
      if (updates.inboxIds !== undefined) set.inboxIds = updates.inboxIds;
      if (updates.enabled !== undefined) set.enabled = updates.enabled;
      const [row] = await db
        .update(webhooks)
        .set(set)
        .where(and(eq(webhooks.podId, podId), eq(webhooks.id, id)))
        .returning();
      return row ?? null;
    },

    async deleteWebhook(podId, id) {
      const deleted = await db
        .delete(webhooks)
        .where(and(eq(webhooks.podId, podId), eq(webhooks.id, id)))
        .returning({ id: webhooks.id });
      return deleted.length > 0;
    },

    async listWebhookDeliveries(podId, webhookId, limit) {
      return db
        .select({
          id: webhookDeliveries.id,
          webhookId: webhookDeliveries.webhookId,
          eventId: webhookDeliveries.eventId,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          lastError: webhookDeliveries.lastError,
          nextRetryAt: webhookDeliveries.nextRetryAt,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
        .where(
          and(eq(webhooks.podId, podId), eq(webhookDeliveries.webhookId, webhookId)),
        )
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(limit);
    },

    async createDraft(record) {
      const [row] = await db.insert(drafts).values(record).returning();
      if (!row) throw new Error('Failed to create draft.');
      return row;
    },

    async listDrafts(podId, inboxId, limit, cursor, status) {
      const conditions: SQL[] = [
        eq(inboxes.podId, podId),
        eq(drafts.inboxId, inboxId),
      ];
      if (status) conditions.push(eq(drafts.status, status));
      if (cursor) {
        conditions.push(
          or(
            lt(drafts.createdAt, cursor.createdAt),
            and(
              eq(drafts.createdAt, cursor.createdAt),
              lt(drafts.id, cursor.id),
            ),
          )!,
        );
      }
      return db
        .select({ draft: drafts })
        .from(drafts)
        .innerJoin(inboxes, eq(drafts.inboxId, inboxes.id))
        .where(and(...conditions))
        .orderBy(desc(drafts.createdAt), desc(drafts.id))
        .limit(limit)
        .then((rows) => rows.map(({ draft }) => draft));
    },

    async findDraftById(podId, inboxId, draftId) {
      const [row] = await db
        .select({ draft: drafts })
        .from(drafts)
        .innerJoin(inboxes, eq(drafts.inboxId, inboxes.id))
        .where(
          and(
            eq(inboxes.podId, podId),
            eq(drafts.inboxId, inboxId),
            eq(drafts.id, draftId),
          ),
        )
        .limit(1);
      return row?.draft ?? null;
    },

    async updateDraft(podId, inboxId, draftId, updates) {
      const set: Partial<typeof drafts.$inferInsert> = {};
      if (updates.to !== undefined) set.to = updates.to;
      if (updates.cc !== undefined) set.cc = updates.cc;
      if (updates.subject !== undefined) set.subject = updates.subject;
      if (updates.text !== undefined) set.text = updates.text;
      if (updates.html !== undefined) set.html = updates.html;
      if (updates.sendAt !== undefined) set.sendAt = updates.sendAt;
      if (updates.status !== undefined) set.status = updates.status;
      const [row] = await db
        .update(drafts)
        .set(set)
        .where(
          and(
            eq(drafts.id, draftId),
            eq(drafts.inboxId, inboxId),
            inArray(drafts.status, ['draft', 'scheduled']),
            exists(
              db
                .select({ id: inboxes.id })
                .from(inboxes)
                .where(and(eq(inboxes.id, inboxId), eq(inboxes.podId, podId))),
            ),
          ),
        )
        .returning();
      return row ?? null;
    },

    async deleteDraft(podId, inboxId, draftId) {
      const deleted = await db
        .delete(drafts)
        .where(
          and(
            eq(drafts.id, draftId),
            eq(drafts.inboxId, inboxId),
            inArray(drafts.status, ['draft', 'scheduled']),
            exists(
              db
                .select({ id: inboxes.id })
                .from(inboxes)
                .where(and(eq(inboxes.id, inboxId), eq(inboxes.podId, podId))),
            ),
          ),
        )
        .returning({ id: drafts.id });
      return deleted.length > 0;
    },

    async claimDraftForSend(podId, inboxId, draftId) {
      return claimDraft(db, {
        draftId,
        inboxId,
        podId,
        statuses: ['draft', 'scheduled'],
      });
    },

    async listDueDraftIds(limit) {
      const rows = await db
        .select({ id: drafts.id })
        .from(drafts)
        .where(
          and(
            eq(drafts.status, 'scheduled'),
            isNotNull(drafts.sendAt),
            lte(drafts.sendAt, new Date()),
          ),
        )
        .orderBy(asc(drafts.sendAt), asc(drafts.id))
        .limit(limit);
      return rows.map(({ id }) => id);
    },

    async claimScheduledDraft(draftId) {
      return claimDraft(db, {
        draftId,
        statuses: ['scheduled'],
        due: true,
      });
    },

    async markDraftStatus(draftId, status) {
      await db
        .update(drafts)
        .set({ status })
        .where(and(eq(drafts.id, draftId), eq(drafts.status, 'sending')));
    },
  };
}

async function claimDraft(
  db: Database,
  options: {
    draftId: string;
    podId?: string;
    inboxId?: string;
    statuses: Array<'draft' | 'scheduled'>;
    due?: boolean;
  },
): Promise<DraftSendTarget | null> {
  return db.transaction(async (transaction) => {
    const conditions: SQL[] = [
      eq(drafts.id, options.draftId),
      inArray(drafts.status, options.statuses),
    ];
    if (options.inboxId) conditions.push(eq(drafts.inboxId, options.inboxId));
    if (options.podId) {
      conditions.push(
        exists(
          transaction
            .select({ id: inboxes.id })
            .from(inboxes)
            .where(
              and(eq(inboxes.id, drafts.inboxId), eq(inboxes.podId, options.podId)),
            ),
        ),
      );
    }
    if (options.due) {
      conditions.push(isNotNull(drafts.sendAt), lte(drafts.sendAt, new Date()));
    }
    const [draft] = await transaction
      .update(drafts)
      .set({ status: 'sending' })
      .where(and(...conditions))
      .returning();
    if (!draft) return null;

    const inboxConditions: SQL[] = [eq(inboxes.id, draft.inboxId)];
    if (options.podId) inboxConditions.push(eq(inboxes.podId, options.podId));
    const [inbox] = await transaction
      .select()
      .from(inboxes)
      .where(and(...inboxConditions))
      .limit(1);
    if (!inbox) return null;
    return { draft, inbox };
  });
}

export function applyLabelUpdates(
  current: string[],
  updates: UpdateMessageLabelsRecord,
): string[] {
  const removeSet = new Set(updates.removeLabels);
  const next = new Set(current.filter((label) => !removeSet.has(label)));
  for (const label of updates.addLabels) next.add(label);
  return [...next];
}
