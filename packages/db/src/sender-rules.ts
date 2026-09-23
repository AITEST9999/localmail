import { and, eq, isNull, or } from 'drizzle-orm';

import type { SenderRule, SenderRuleLoader } from '@localmail/core';

import type { Database } from './client.js';
import { senderRules } from './schema.js';

/** Pod-wide (`inbox_id` null) plus inbox-specific sender rules for P3-16. */
export function createSenderRuleLoader(db: Database): SenderRuleLoader {
  return {
    async listForInbox(podId, inboxId): Promise<SenderRule[]> {
      const rows = await db
        .select({
          id: senderRules.id,
          podId: senderRules.podId,
          inboxId: senderRules.inboxId,
          pattern: senderRules.pattern,
          action: senderRules.action,
        })
        .from(senderRules)
        .where(
          and(
            eq(senderRules.podId, podId),
            or(isNull(senderRules.inboxId), eq(senderRules.inboxId, inboxId)),
          ),
        );

      return rows.map((row) => ({
        id: row.id,
        podId: row.podId,
        inboxId: row.inboxId ?? null,
        pattern: row.pattern,
        action: row.action,
      }));
    },
  };
}
