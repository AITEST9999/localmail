import type { Inbox, Message } from '@localmail/sdk';

import {
  PROPOSED_SLOTS,
  chooseSlot,
  formatAcceptance,
  formatConfirmation,
  formatProposal,
  isConfirmation,
  parseAcceptance,
  parseProposal,
  type Slot,
} from './protocol.js';

export interface NegotiationSdk {
  inboxes: {
    create(input: { client_id?: string }): Promise<Inbox>;
  };
  messages: {
    send(inboxId: string, input: { to: string[]; subject: string; text: string }): Promise<Message>;
  };
  waitForEmail(inboxId: string, options: { from?: string; since?: Date; timeoutMs?: number }): Promise<Message>;
  replyToThread(inboxId: string, threadId: string, input: { text: string }): Promise<Message>;
}

export interface NegotiationResult {
  alice: Inbox;
  bob: Inbox;
  chosenSlot: Slot;
  aliceThreadId: string;
  bobThreadId: string;
  messageCount: number;
}

/** Bob's hard-coded calendar for this demo — slot-1 is always busy. */
export const BOB_BUSY_SLOT_IDS = ['slot-1'];

/**
 * Alice proposes three slots; Bob accepts the first free one; Alice
 * confirms. Three loopback messages total, all in one thread per inbox. No
 * LLM calls anywhere in this flow.
 */
/** A little slack before each send, so the millisecond that lands in the DB is never earlier than `since`. */
function justBefore(): Date {
  return new Date(Date.now() - 50);
}

export async function runNegotiation(sdk: NegotiationSdk, timeoutMs = 15_000): Promise<NegotiationResult> {
  const alice = await sdk.inboxes.create({ client_id: `a2a-alice-${Date.now()}` });
  const bob = await sdk.inboxes.create({ client_id: `a2a-bob-${Date.now()}` });

  // §3.4: capture `since` *before* triggering the email, or a fast pure-loopback
  // send (which completes synchronously with ingest) can land before `since`.
  const sinceProposal = justBefore();
  await sdk.messages.send(alice.id, {
    to: [bob.address],
    subject: 'Meeting proposal',
    text: formatProposal(PROPOSED_SLOTS),
  });

  const proposalAtBob = await sdk.waitForEmail(bob.id, { from: alice.address, since: sinceProposal, timeoutMs });
  const proposedSlots = parseProposal(proposalAtBob.extracted_text ?? '');
  const chosen = chooseSlot(proposedSlots, BOB_BUSY_SLOT_IDS);
  if (!chosen) throw new Error('Bob has no free slot among those proposed.');

  const sinceAcceptance = justBefore();
  await sdk.replyToThread(bob.id, proposalAtBob.thread_id, { text: formatAcceptance(chosen) });

  const acceptanceAtAlice = await sdk.waitForEmail(alice.id, {
    from: bob.address,
    since: sinceAcceptance,
    timeoutMs,
  });
  const acceptedId = parseAcceptance(acceptanceAtAlice.extracted_text ?? '');
  if (!acceptedId) throw new Error("Could not parse Bob's acceptance.");
  const chosenSlot = PROPOSED_SLOTS.find((slot) => slot.id === acceptedId);
  if (!chosenSlot) throw new Error(`Unknown slot id in Bob's acceptance: ${acceptedId}`);

  const sinceConfirmation = justBefore();
  await sdk.replyToThread(alice.id, acceptanceAtAlice.thread_id, { text: formatConfirmation(chosenSlot) });

  const confirmationAtBob = await sdk.waitForEmail(bob.id, {
    from: alice.address,
    since: sinceConfirmation,
    timeoutMs,
  });
  if (!isConfirmation(confirmationAtBob.extracted_text ?? '')) {
    throw new Error('Expected a confirmation message.');
  }

  // Both sides stop here — Bob never replies to a confirmation (explicit terminal state).
  return {
    alice,
    bob,
    chosenSlot,
    aliceThreadId: acceptanceAtAlice.thread_id,
    bobThreadId: proposalAtBob.thread_id,
    messageCount: 3,
  };
}
