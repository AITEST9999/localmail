import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LocalMail } from '@localmail/sdk';

import { DEFAULT_REPLY_TEXT, runAutoReplyAgent } from './agent.js';
import { mailpitTotal } from './mailpit.js';
import { deliverFixture, deliverRaw, sleep } from './smtp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'emails');

async function main(): Promise<void> {
  const sdk = new LocalMail();
  const inbox = await sdk.inboxes.create({ client_id: `auto-reply-smoke-${Date.now()}` });
  console.log(`inbox: ${inbox.id} ${inbox.address}`);

  const agent = await runAutoReplyAgent(sdk, inbox.id, {
    onReply: (message) => console.log(`  -> replied ${message.id} in thread ${message.thread_id}`),
    onError: (error) => console.error('  !! agent error', error),
  });
  await agent.ready;

  const noReplyCases = ['05-out-of-office.eml', '06-bounce.eml', '01-billing-complaint.eml'];
  for (const fixture of noReplyCases) {
    const before = await mailpitTotal();
    await deliverFixture(join(FIXTURES, fixture), inbox.address);
    await sleep(1500);
    const after = await mailpitTotal();
    console.log(`${fixture}: Mailpit ${before} -> ${after} (expected unchanged)`);
    if (after !== before) throw new Error(`${fixture} unexpectedly triggered a reply`);
  }

  const beforeSupport = await mailpitTotal();
  await deliverRaw({
    to: inbox.address,
    subject: 'Bug report: app crashes on login',
    text: 'I found a bug — the app crashes every time I try to log in. Can you help troubleshoot this technical problem?',
  });
  await sleep(1500);
  const afterSupport = await mailpitTotal();
  console.log(`support message: Mailpit ${beforeSupport} -> ${afterSupport} (expected +1)`);
  if (afterSupport !== beforeSupport + 1) {
    throw new Error('Expected exactly one reply to the support message.');
  }

  // Restart-safety: the mechanism that protects a real restart is server-side
  // Idempotency-Key replay. Prove it directly: replay the same reply call
  // (as a restarted agent reprocessing the same message.labeled event would)
  // and confirm Mailpit's count does not move again.
  const thread = await sdk.threads.list(inbox.id, { limit: 1 }).then((page) => page.data[0]!);
  const { messages } = await sdk.threads.get(inbox.id, thread.id);
  const supportMessage = messages.find((m) => m.direction === 'inbound')!;
  // Same key AND same body: a real restart would resend the identical reply
  // the agent already built. A different body with a reused key is a 409
  // conflict, by design — that's a caller bug, not a safe replay.
  await sdk.messages.reply(
    inbox.id,
    supportMessage.id,
    { text: DEFAULT_REPLY_TEXT },
    { idempotencyKey: `auto-reply:${supportMessage.id}` },
  );
  const afterReplay = await mailpitTotal();
  console.log(`idempotent replay: Mailpit ${afterSupport} -> ${afterReplay} (expected unchanged)`);
  if (afterReplay !== afterSupport) {
    throw new Error('A replayed auto-reply (same Idempotency-Key) must not send a second email.');
  }

  agent.stop();
  console.log('SMOKE OK');
}

main().catch((error: unknown) => {
  console.error('SMOKE FAILED', error);
  process.exitCode = 1;
});
