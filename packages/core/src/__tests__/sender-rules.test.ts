import { describe, expect, it } from 'vitest';

import {
  CLASSIFY_SKIP_LABEL,
  createSenderRulesRecipientPolicy,
  evaluateSenderRules,
  extractEmailAddress,
  matchSenderPattern,
  shouldSkipClassify,
  type SenderRule,
} from '../sender-rules.js';

const baseRule = (
  overrides: Partial<SenderRule> & Pick<SenderRule, 'id' | 'pattern' | 'action'>,
): SenderRule => ({
  podId: 'pod_test',
  inboxId: null,
  ...overrides,
});

describe('matchSenderPattern', () => {
  it('matches exact addresses case-insensitively', () => {
    expect(matchSenderPattern('Alice@Spam.COM', 'alice@spam.com')).toBe(true);
    expect(matchSenderPattern('alice@spam.com', 'bob@spam.com')).toBe(false);
  });

  it('matches *@domain and @domain wildcards', () => {
    expect(matchSenderPattern('*@spam.com', 'eve@spam.com')).toBe(true);
    expect(matchSenderPattern('@spam.com', 'eve@spam.com')).toBe(true);
    expect(matchSenderPattern('*@spam.com', 'eve@ham.com')).toBe(false);
  });

  it('matches bare domain as *@domain', () => {
    expect(matchSenderPattern('spam.com', 'eve@spam.com')).toBe(true);
    expect(matchSenderPattern('spam.com', 'eve@notspam.com')).toBe(false);
  });

  it('extracts angle-bracket addresses', () => {
    expect(extractEmailAddress('Alice <alice@example.com>')).toBe(
      'alice@example.com',
    );
    expect(matchSenderPattern('alice@example.com', 'Alice <alice@example.com>')).toBe(
      true,
    );
  });
});

describe('evaluateSenderRules', () => {
  it('defaults to accept when no rules match', () => {
    expect(
      evaluateSenderRules(
        [baseRule({ id: 'r1', pattern: '*@spam.com', action: 'block' })],
        'friend@example.com',
        'drop',
      ),
    ).toEqual({ disposition: 'accept', labels: [], skipClassify: false });
  });

  it('rejects in drop mode when a block rule matches', () => {
    const decision = evaluateSenderRules(
      [baseRule({ id: 'r_block', pattern: '*@spam.com', action: 'block' })],
      'bot@spam.com',
      'drop',
    );
    expect(decision.disposition).toBe('reject');
    expect(decision.matchedRuleId).toBe('r_block');
    expect(decision.skipClassify).toBe(false);
  });

  it('returns spam disposition with classify-skip labels in spam mode', () => {
    const decision = evaluateSenderRules(
      [baseRule({ id: 'r_block', pattern: 'bot@spam.com', action: 'block' })],
      'bot@spam.com',
      'spam',
    );
    expect(decision).toEqual({
      disposition: 'spam',
      reason: 'Sender blocked by rule r_block (spam mode)',
      matchedRuleId: 'r_block',
      labels: ['spam', 'unread', CLASSIFY_SKIP_LABEL],
      skipClassify: true,
    });
    expect(shouldSkipClassify(decision.labels)).toBe(true);
  });

  it('lets allow override block (inbox allow beats pod block)', () => {
    const decision = evaluateSenderRules(
      [
        baseRule({ id: 'pod_block', pattern: '*@spam.com', action: 'block' }),
        baseRule({
          id: 'inbox_allow',
          pattern: 'friend@spam.com',
          action: 'allow',
          inboxId: 'inb_test',
        }),
      ],
      'friend@spam.com',
      'drop',
    );
    expect(decision.disposition).toBe('accept');
    expect(decision.matchedRuleId).toBe('inbox_allow');
  });
});

describe('createSenderRulesRecipientPolicy', () => {
  const inbox = {
    id: 'inb_test',
    podId: 'pod_test',
    address: 'agent@localmail.test',
  };

  it('maps drop-mode blocks to allowed:false', async () => {
    const policy = createSenderRulesRecipientPolicy({
      blockMode: 'drop',
      loader: {
        listForInbox: () =>
          Promise.resolve([
            baseRule({ id: 'r1', pattern: '*@evil.test', action: 'block' }),
          ]),
      },
    });
    await expect(
      policy.evaluate({
        inbox,
        mailFrom: 'x@evil.test',
        remoteAddress: '127.0.0.1',
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Sender blocked by rule r1',
    });
  });

  it('maps spam-mode blocks to ingest overrides with skipClassify', async () => {
    const policy = createSenderRulesRecipientPolicy({
      blockMode: 'spam',
      loader: {
        listForInbox: () =>
          Promise.resolve([
            baseRule({ id: 'r1', pattern: '*@evil.test', action: 'block' }),
          ]),
      },
    });
    await expect(
      policy.evaluate({
        inbox,
        mailFrom: 'x@evil.test',
        remoteAddress: '127.0.0.1',
      }),
    ).resolves.toEqual({
      allowed: true,
      ingest: {
        labels: ['spam', 'unread', CLASSIFY_SKIP_LABEL],
        skipClassify: true,
      },
    });
  });
});
