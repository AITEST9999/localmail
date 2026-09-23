import { describe, expect, it, vi } from 'vitest';

import { CLASSIFY_SKIP_LABEL } from '@localmail/core';

import { processJevClassify } from './classify.js';

describe('processJevClassify', () => {
  it('skips when skip_classify is present (P3-16)', async () => {
    const classifySpy = vi.fn();
    const emit = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    id: 'msg_blocked',
                    inboxId: 'inb_demo',
                    threadId: 'thr_1',
                    from: 'bot@evil.test',
                    subject: 'junk',
                    text: 'nope',
                    extractedText: 'nope',
                    labels: ['spam', 'unread', CLASSIFY_SKIP_LABEL],
                    podId: 'pod_local_dev',
                  },
                ]),
            }),
          }),
        }),
      }),
      transaction: vi.fn(),
    };

    // Avoid importing real classify — stub via module would be heavier; we only
    // assert skip before classify by ensuring transaction never runs.
    const outcome = await processJevClassify({
      messageId: 'msg_blocked',
      db: db as never,
      eventPublisher: { emit },
      classifyOptions: { jevEnabled: false },
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'skip_classify' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('skips when the message row is missing', async () => {
    const emit = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
      transaction: vi.fn(),
    };

    const outcome = await processJevClassify({
      messageId: 'msg_missing',
      db: db as never,
      eventPublisher: { emit },
      classifyOptions: { jevEnabled: false },
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'missing' });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
