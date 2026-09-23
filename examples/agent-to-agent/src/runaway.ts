import { LocalMailError } from '@localmail/sdk';
import type { Inbox } from '@localmail/sdk';

export interface RunawaySdk {
  inboxes: {
    create(input: { client_id?: string }): Promise<Inbox>;
  };
  messages: {
    send(inboxId: string, input: { to: string[]; subject: string; text: string }): Promise<{ id: string }>;
    list(inboxId: string, query: { limit?: number }): Promise<{ data: Array<{ id: string }> }>;
    reply(inboxId: string, messageId: string, input: { text: string }): Promise<{ id: string }>;
  };
}

export interface RunawayResult {
  alice: Inbox;
  bob: Inbox;
  hopsReached: number;
}

/**
 * D4.3 demo: both agents blindly reply to everything, ignoring any terminal
 * marker. LocalMail's `X-LocalMail-Hop-Count` guard (independent of this
 * example) is the backstop that must stop it — this loop has no hop limit
 * of its own. Loopback delivery is synchronous with the HTTP response
 * (P1-8), so each reply's recipient copy is already queryable by the time
 * `reply()` resolves — no polling needed between hops.
 */
export async function runRunaway(sdk: RunawaySdk): Promise<RunawayResult> {
  const alice = await sdk.inboxes.create({ client_id: `a2a-runaway-alice-${Date.now()}` });
  const bob = await sdk.inboxes.create({ client_id: `a2a-runaway-bob-${Date.now()}` });

  await sdk.messages.send(alice.id, { to: [bob.address], subject: 'loop', text: 'go (runaway demo)' });

  let holder = bob.id;
  let other = alice.id;
  let hops = 0;

  for (;;) {
    const page = await sdk.messages.list(holder, { limit: 1 });
    const latest = page.data[0];
    if (!latest) throw new Error('Expected a message to reply to.');
    try {
      await sdk.messages.reply(holder, latest.id, { text: `reply #${hops + 1}` });
      hops += 1;
      [holder, other] = [other, holder];
    } catch (error) {
      if (error instanceof LocalMailError && /hop/i.test(error.message)) {
        return { alice, bob, hopsReached: hops };
      }
      throw error;
    }
  }
}
