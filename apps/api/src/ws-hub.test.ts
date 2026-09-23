import { describe, expect, it } from 'vitest';

import type { WebhookEventEnvelope } from '@localmail/events';

import {
  KNOWN_EVENT_TYPES,
  matchesFilter,
  resolveSubscribeFilter,
  type ConnectionFilter,
} from './ws-hub.js';

const envelope = (
  overrides: Partial<WebhookEventEnvelope> &
    Pick<WebhookEventEnvelope, 'type'> & {
      inbox_id?: string;
    },
): WebhookEventEnvelope => ({
  id: 'evt_1',
  type: overrides.type,
  created_at: '2026-09-23T12:00:00.000Z',
  pod_id: 'pod_test',
  data: {
    inbox_id: overrides.inbox_id ?? 'inb_demo',
    thread_id: 'thr_1',
    message_id: 'msg_1',
  },
});

describe('matchesFilter', () => {
  it('treats null filters as all', () => {
    const filter: ConnectionFilter = { inboxIds: null, eventTypes: null };
    expect(matchesFilter(envelope({ type: 'message.received' }), filter)).toBe(
      true,
    );
  });

  it('treats empty arrays as none', () => {
    expect(
      matchesFilter(envelope({ type: 'message.received' }), {
        inboxIds: [],
        eventTypes: null,
      }),
    ).toBe(false);
    expect(
      matchesFilter(envelope({ type: 'message.received' }), {
        inboxIds: null,
        eventTypes: [],
      }),
    ).toBe(false);
  });

  it('matches explicit inbox and event type allow-lists', () => {
    const filter: ConnectionFilter = {
      inboxIds: ['inb_demo'],
      eventTypes: ['message.received'],
    };
    expect(matchesFilter(envelope({ type: 'message.received' }), filter)).toBe(
      true,
    );
    expect(
      matchesFilter(
        envelope({ type: 'message.received', inbox_id: 'inb_other' }),
        filter,
      ),
    ).toBe(false);
    expect(matchesFilter(envelope({ type: 'message.sent' }), filter)).toBe(
      false,
    );
  });
});

describe('resolveSubscribeFilter', () => {
  const inboxes = new Set(['inb_demo']);
  const findInboxById = (podId: string, inboxId: string) =>
    Promise.resolve(
      podId === 'pod_test' && inboxes.has(inboxId) ? { id: inboxId } : null,
    );

  it('rejects unknown or cross-pod inbox ids identically', async () => {
    const missing = await resolveSubscribeFilter(
      'pod_test',
      { inbox_ids: ['inb_missing'] },
      findInboxById,
    );
    expect(missing).toMatchObject({
      error: { code: 'invalid_inbox_id' },
    });

    const foreign = await resolveSubscribeFilter(
      'pod_other',
      { inbox_ids: ['inb_demo'] },
      findInboxById,
    );
    expect(foreign).toMatchObject({
      error: { code: 'invalid_inbox_id' },
    });
  });

  it('rejects unknown event types but allows deferred Phase types', async () => {
    const bad = await resolveSubscribeFilter(
      'pod_test',
      { event_types: ['not-a-real-type'] },
      findInboxById,
    );
    expect(bad).toMatchObject({
      error: { code: 'invalid_event_type' },
    });

    const deferred = await resolveSubscribeFilter(
      'pod_test',
      { event_types: ['message.labeled'] },
      findInboxById,
    );
    expect(deferred).toEqual({
      filter: { inboxIds: null, eventTypes: ['message.labeled'] },
    });
    expect(KNOWN_EVENT_TYPES.has('webhook.test')).toBe(false);
  });

  it('resolves omitted fields to null (all) and [] to empty allow-list', async () => {
    const all = await resolveSubscribeFilter('pod_test', {}, findInboxById);
    expect(all).toEqual({
      filter: { inboxIds: null, eventTypes: null },
    });

    const none = await resolveSubscribeFilter(
      'pod_test',
      { inbox_ids: [], event_types: [] },
      findInboxById,
    );
    expect(none).toEqual({
      filter: { inboxIds: [], eventTypes: [] },
    });
  });
});
