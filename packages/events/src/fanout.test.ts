import { describe, expect, it } from 'vitest';

import { planEventFanout } from './fanout.js';

describe('planEventFanout (P3-17)', () => {
  it('suppresses webhook, WS, and jev-classify for Auto-Submitted receives', () => {
    expect(
      planEventFanout({
        type: 'message.received',
        podId: 'pod_1',
        inboxId: 'inb_1',
        threadId: 'thr_1',
        messageId: 'msg_1',
        suppressAgentTriggers: true,
      }),
    ).toEqual({ webhooks: false, ws: false, jevClassify: false });
  });

  it('fans out normally for ordinary message.received', () => {
    expect(
      planEventFanout({
        type: 'message.received',
        podId: 'pod_1',
        inboxId: 'inb_1',
        threadId: 'thr_1',
        messageId: 'msg_1',
      }),
    ).toEqual({ webhooks: true, ws: true, jevClassify: true });
  });

  it('still fans out message.labeled (including auto from Jev fallback)', () => {
    expect(
      planEventFanout({
        type: 'message.labeled',
        podId: 'pod_1',
        inboxId: 'inb_1',
        threadId: 'thr_1',
        messageId: 'msg_1',
        labels: ['inbox', 'unread', 'auto'],
      }),
    ).toEqual({ webhooks: true, ws: true, jevClassify: false });
  });
});
