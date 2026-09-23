/**
 * Sender allow/block matching (P3-16 / agentmail.md §2.8).
 *
 * Pattern rules (local MVP — not a full ACL language):
 * - Exact address: `alice@spam.com` (case-insensitive)
 * - Domain wildcard: `*@spam.com` or `@spam.com` (any local-part at that domain)
 * - Domain only: `spam.com` (same as `*@spam.com`)
 *
 * Evaluation:
 * 1. Load pod-wide rules (`inbox_id` null) plus inbox-specific rules.
 * 2. Inbox-specific matches win over pod-wide matches for the same action conflict:
 *    if any matching **allow** exists (prefer inbox-scoped), the sender is accepted.
 * 3. Else if any matching **block** exists, apply `SENDER_BLOCK_MODE`:
 *    - `drop` → reject at RCPT TO (never reaches DB)
 *    - `spam` → accept at RCPT; ingest with `spam` + `skip_classify` labels (no Jev)
 * 4. Default when nothing matches: accept with normal `inbox,unread` labels.
 */

import type {
  RecipientPolicy,
  RecipientPolicyContext,
  RecipientPolicyDecision,
} from './inbound-contracts.js';

export type SenderRuleAction = 'allow' | 'block';
export type SenderBlockMode = 'drop' | 'spam';

/** Durable label: future jev-classify must skip when present (P3-16 spam mode). */
export const CLASSIFY_SKIP_LABEL = 'skip_classify' as const;

export interface SenderRule {
  id: string;
  podId: string;
  inboxId: string | null;
  pattern: string;
  action: SenderRuleAction;
}

export interface SenderRulesDecision {
  disposition: 'accept' | 'reject' | 'spam';
  reason?: string;
  matchedRuleId?: string;
  /** Labels to apply at ingest when disposition is `spam`. */
  labels: string[];
  skipClassify: boolean;
}

export function shouldSkipClassify(labels: readonly string[]): boolean {
  return labels.includes(CLASSIFY_SKIP_LABEL);
}

export function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  const candidate = (angle?.[1] ?? trimmed).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

/**
 * Returns true when `pattern` matches `address` (both already normalized or raw).
 */
export function matchSenderPattern(pattern: string, address: string): boolean {
  const normalizedAddress = extractEmailAddress(address);
  if (!normalizedAddress) return false;
  const at = normalizedAddress.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = normalizedAddress.slice(at + 1);

  const raw = pattern.trim().toLowerCase();
  if (!raw) return false;

  if (raw.startsWith('*@') || raw.startsWith('@')) {
    const patternDomain = raw.replace(/^\*?@/, '');
    return patternDomain.length > 0 && domain === patternDomain;
  }

  if (!raw.includes('@')) {
    return domain === raw;
  }

  return normalizedAddress === raw;
}

export function evaluateSenderRules(
  rules: readonly SenderRule[],
  mailFrom: string | null,
  blockMode: SenderBlockMode,
): SenderRulesDecision {
  const address = extractEmailAddress(mailFrom);
  if (!address) {
    return { disposition: 'accept', labels: [], skipClassify: false };
  }

  const matches = rules.filter((rule) => matchSenderPattern(rule.pattern, address));
  if (matches.length === 0) {
    return { disposition: 'accept', labels: [], skipClassify: false };
  }

  const inboxAllows = matches.filter(
    (rule) => rule.action === 'allow' && rule.inboxId != null,
  );
  const podAllows = matches.filter(
    (rule) => rule.action === 'allow' && rule.inboxId == null,
  );
  const allow = inboxAllows[0] ?? podAllows[0];
  if (allow) {
    return {
      disposition: 'accept',
      matchedRuleId: allow.id,
      labels: [],
      skipClassify: false,
    };
  }

  const inboxBlocks = matches.filter(
    (rule) => rule.action === 'block' && rule.inboxId != null,
  );
  const podBlocks = matches.filter(
    (rule) => rule.action === 'block' && rule.inboxId == null,
  );
  const block = inboxBlocks[0] ?? podBlocks[0];
  if (!block) {
    return { disposition: 'accept', labels: [], skipClassify: false };
  }

  if (blockMode === 'drop') {
    return {
      disposition: 'reject',
      reason: `Sender blocked by rule ${block.id}`,
      matchedRuleId: block.id,
      labels: [],
      skipClassify: false,
    };
  }

  return {
    disposition: 'spam',
    reason: `Sender blocked by rule ${block.id} (spam mode)`,
    matchedRuleId: block.id,
    labels: ['spam', 'unread', CLASSIFY_SKIP_LABEL],
    skipClassify: true,
  };
}

export interface SenderRuleLoader {
  listForInbox(podId: string, inboxId: string): Promise<SenderRule[]>;
}

export function createSenderRulesRecipientPolicy(options: {
  loader: SenderRuleLoader;
  blockMode: SenderBlockMode;
}): RecipientPolicy {
  const { loader, blockMode } = options;
  return {
    async evaluate(
      context: RecipientPolicyContext,
    ): Promise<RecipientPolicyDecision> {
      const rules = await loader.listForInbox(
        context.inbox.podId,
        context.inbox.id,
      );
      const decision = evaluateSenderRules(rules, context.mailFrom, blockMode);

      if (decision.disposition === 'reject') {
        return {
          allowed: false,
          reason: decision.reason ?? 'Sender blocked by policy',
        };
      }

      if (decision.disposition === 'spam') {
        return {
          allowed: true,
          ingest: {
            labels: decision.labels,
            skipClassify: true,
          },
        };
      }

      return { allowed: true };
    },
  };
}
