import { describe, expect, it } from 'vitest';

import {
  getThreadingMessageIds,
  resolveThread,
  type ThreadLookup,
  type ThreadLookupQuery,
} from '../index.js';
import {
  existingThread,
  longReplyChain,
  mismatchedSubjectPrefixes,
  missingReferences,
  type ThreadFixture,
} from './fixtures/threading.js';

function createLookup(
  messageIds: ReadonlyMap<string, ThreadFixture>,
  threads: readonly ThreadFixture[] = [existingThread],
): { lookup: ThreadLookup<ThreadFixture>; queries: ThreadLookupQuery[] } {
  const queries: ThreadLookupQuery[] = [];
  const lookup: ThreadLookup<ThreadFixture> = (query) => {
    queries.push(query);

    if (query.kind === 'subject') {
      return threads.find((thread) => thread.subjectNormalized === query.normalizedSubject) ?? null;
    }

    for (const messageId of query.messageIds) {
      const thread = messageIds.get(messageId);
      if (thread) return thread;
    }
    return null;
  };

  return { lookup, queries };
}

describe('resolveThread', () => {
  it('threads every message in a long reply chain through its headers', async () => {
    const messageIds = new Map<string, ThreadFixture>();

    for (const [index, message] of longReplyChain.entries()) {
      const { lookup } = createLookup(messageIds);
      const resolution = await resolveThread(message, lookup);

      if (index === 0) {
        expect(resolution).toEqual({ thread: existingThread, matchedBy: 'subject' });
      } else {
        expect(resolution).toEqual({ thread: existingThread, matchedBy: 'headers' });
      }

      const currentId = getThreadingMessageIds({ messageId: message.messageId })[0];
      if (currentId) messageIds.set(currentId, existingThread);
    }
  });

  it('falls back to a normalized subject with mismatched prefixes', async () => {
    const { lookup, queries } = createLookup(new Map());

    const resolution = await resolveThread(mismatchedSubjectPrefixes, lookup);

    expect(resolution).toEqual({ thread: existingThread, matchedBy: 'subject' });
    expect(queries).toEqual([
      { kind: 'message-ids', messageIds: ['<atlas-forwarded@external.test>'] },
      { kind: 'subject', normalizedSubject: 'project atlas' },
    ]);
  });

  it('uses In-Reply-To when References is missing', async () => {
    const { lookup, queries } = createLookup(
      new Map([['<atlas-3@localmail.test>', existingThread]]),
    );

    const resolution = await resolveThread(missingReferences, lookup);

    expect(resolution).toEqual({ thread: existingThread, matchedBy: 'headers' });
    expect(queries).toHaveLength(1);
  });

  it('prioritizes the current ID, immediate parent, then newest ancestors', () => {
    expect(getThreadingMessageIds(longReplyChain[3] ?? {})).toEqual([
      '<atlas-4@localmail.test>',
      '<atlas-3@localmail.test>',
      '<atlas-2@localmail.test>',
      '<atlas-1@localmail.test>',
    ]);
  });

  it('does not perform an empty subject fallback', async () => {
    const { lookup, queries } = createLookup(new Map(), []);

    await expect(resolveThread({ subject: 'Re: Fwd:' }, lookup)).resolves.toEqual({
      thread: null,
      matchedBy: null,
    });
    expect(queries).toEqual([]);
  });
});
