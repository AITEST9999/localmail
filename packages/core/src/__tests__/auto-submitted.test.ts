import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  createInboundIngestor,
  isAutoSubmittedShortCircuit,
  type InboxRecipient,
  type MessageEvent,
  type PersistInboundMessage,
} from '../index.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/emails',
);

const inbox: InboxRecipient = {
  id: 'inb_test',
  podId: 'pod_test',
  address: 'agent@localmail.test',
};

describe('isAutoSubmittedShortCircuit', () => {
  it('matches RFC 3834 reply/bounce markers (case-insensitive)', () => {
    expect(isAutoSubmittedShortCircuit('auto-replied')).toBe(true);
    expect(isAutoSubmittedShortCircuit('Auto-Generated')).toBe(true);
    expect(isAutoSubmittedShortCircuit(' auto-notified ')).toBe(true);
  });

  it('does not treat no / missing / other values as short-circuit', () => {
    expect(isAutoSubmittedShortCircuit('no')).toBe(false);
    expect(isAutoSubmittedShortCircuit(null)).toBe(false);
    expect(isAutoSubmittedShortCircuit(undefined)).toBe(false);
    expect(isAutoSubmittedShortCircuit('auto')).toBe(false);
  });
});

describe('P3-17 Auto-Submitted ingest short-circuit', () => {
  it('OOO fixture: labels auto, skipClassify, suppresses received triggers, emits labeled', async () => {
    const persisted: PersistInboundMessage[] = [];
    const events: MessageEvent[] = [];
    const classifySpy = vi.fn();
    const raw = await readFile(path.join(FIXTURES, '05-out-of-office.eml'));
    const ingestor = createInboundIngestor({
      mailDomain: 'localmail.test',
      repository: {
        findByAddress: () => Promise.resolve(inbox),
        lookupThread: () => Promise.resolve(null),
        persistMessage(message) {
          persisted.push(message);
          return Promise.resolve({
            messageId: message.id,
            threadId: message.newThreadId,
          });
        },
      },
      objectStore: {
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      eventPublisher: {
        emit(event) {
          events.push(event);
          // Simulate that jev-classify is only enqueued from emit fan-out —
          // a real publisher with suppressAgentTriggers never calls this.
          if (
            event.type === 'message.received' &&
            !event.suppressAgentTriggers
          ) {
            classifySpy();
          }
        },
      },
    });

    await ingestor.ingest(raw, inbox);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.labels).toEqual(
      expect.arrayContaining(['inbox', 'unread', 'auto']),
    );
    expect(persisted[0]?.skipClassify).toBe(true);
    expect(events[0]).toMatchObject({
      type: 'message.received',
      suppressAgentTriggers: true,
    });
    expect(events[1]?.type).toBe('message.labeled');
    if (events[1]?.type === 'message.labeled') {
      expect(events[1].labels).toEqual(
        expect.arrayContaining(['auto']),
      );
    }
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('bounce fixture: same short-circuit (zero classify enqueue signal)', async () => {
    const events: MessageEvent[] = [];
    const raw = await readFile(path.join(FIXTURES, '06-bounce.eml'));
    const ingestor = createInboundIngestor({
      mailDomain: 'localmail.test',
      repository: {
        findByAddress: () => Promise.resolve(inbox),
        lookupThread: () => Promise.resolve(null),
        persistMessage(message) {
          return Promise.resolve({
            messageId: message.id,
            threadId: message.newThreadId,
          });
        },
      },
      objectStore: {
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      eventPublisher: {
        emit(event) {
          events.push(event);
        },
      },
    });

    await ingestor.ingest(raw, inbox);
    const received = events.find((event) => event.type === 'message.received');
    expect(received).toMatchObject({ suppressAgentTriggers: true });
    expect(events.some((event) => event.type === 'message.labeled')).toBe(true);
  });
});
