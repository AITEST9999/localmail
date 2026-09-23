import { describe, expect, it, vi } from 'vitest';
import { runScheduledSendTick, type ScheduledDraftStore } from './scheduled-send.js';
import type { DraftSendTarget } from '@localmail/api/store';
import type { OutboundMessageService } from '@localmail/api/outbound';

function target(): DraftSendTarget {
  return {
    draft: {
      id: 'draft-1', inboxId: 'inbox-1', threadId: null, to: ['to@example.test'], cc: [],
      subject: 'Scheduled', text: 'body', html: null, sendAt: new Date(), status: 'sending', createdAt: new Date(),
    },
    inbox: {
      id: 'inbox-1', podId: 'pod-1', username: 'agent', domain: 'example.test',
      address: 'agent@example.test', displayName: null, metadata: {}, clientId: null, createdAt: new Date(),
    },
  };
}

type TestStore = ScheduledDraftStore & { statusCalls: Array<[string, 'sent' | 'failed']> };
function store(claim: DraftSendTarget | null): TestStore {
  const statusCalls: Array<[string, 'sent' | 'failed']> = [];
  return {
    listDueDraftIds: vi.fn().mockResolvedValue(['draft-1']),
    claimScheduledDraft: vi.fn().mockResolvedValue(claim),
    markDraftStatus: vi.fn((id: string, status: 'sent' | 'failed') => { statusCalls.push([id, status]); return Promise.resolve(); }),
    statusCalls,
  };
}

type FakeOutbound = Pick<OutboundMessageService, 'send'>;

describe('scheduled send poller', () => {
  it('claims and marks a due draft sent', async () => {
    const s = store(target());
    const send = vi.fn<OutboundMessageService['send']>(() => Promise.resolve({} as Awaited<ReturnType<OutboundMessageService['send']>>));
    const outbound: FakeOutbound = { send };
    expect(await runScheduledSendTick({ store: s, outbound })).toBe(1);
    expect(outbound.send).toHaveBeenCalledOnce();
    expect(s.statusCalls).toContainEqual(['draft-1', 'sent']);
  });

  it('silently skips a lost claim', async () => {
    const s = store(null);
    const send = vi.fn<OutboundMessageService['send']>(() => Promise.reject(new Error('unexpected')));
    const outbound: FakeOutbound = { send };
    expect(await runScheduledSendTick({ store: s, outbound })).toBe(0);
    expect(outbound.send).not.toHaveBeenCalled();
  });

  it('marks a failed outbound as failed and continues', async () => {
    const s = store(target());
    const send = vi.fn<OutboundMessageService['send']>(() => Promise.reject(new Error('smtp down')));
    const outbound: FakeOutbound = { send };
    const onError = vi.fn();
    expect(await runScheduledSendTick({ store: s, outbound, onError })).toBe(0);
    expect(s.statusCalls).toContainEqual(['draft-1', 'failed']);
    expect(onError).toHaveBeenCalledOnce();
  });
});
