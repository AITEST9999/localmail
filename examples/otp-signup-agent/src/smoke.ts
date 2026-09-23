import { LocalMail, LocalMailTimeoutError } from '@localmail/sdk';

import { signupAndVerify } from './agent.js';
import { createFakeSignupService } from './fake-signup-service.js';

async function main(): Promise<void> {
  const sdk = new LocalMail();
  const clientId = `otp-smoke-${Date.now()}`;

  const first = await signupAndVerify(sdk, createFakeSignupService(), { clientId, timeoutMs: 15_000 });
  console.log(`verified in ${first.elapsedMs} ms (inbox ${first.inbox.id})`);
  if (!first.verified) throw new Error('Expected verification to succeed.');

  const second = await signupAndVerify(sdk, createFakeSignupService(), { clientId, timeoutMs: 15_000 });
  console.log(`second run with the same client_id reused inbox ${second.inbox.id === first.inbox.id}`);
  if (second.inbox.id !== first.inbox.id) throw new Error('Expected the same inbox for the same client_id.');

  const race = await signupAndVerify(sdk, createFakeSignupService(), { race: true, timeoutMs: 15_000 });
  console.log(`--race verified in ${race.elapsedMs} ms (resolved via catch-up)`);
  if (!race.verified) throw new Error('Expected the --race run to verify via catch-up.');

  try {
    await signupAndVerify(sdk, createFakeSignupService(), {
      fromOverride: 'sender-that-never-matches.example.com',
      timeoutMs: 3000,
    });
    throw new Error('Expected a clean timeout with a wrong sender filter.');
  } catch (error) {
    if (!(error instanceof LocalMailTimeoutError)) throw error;
    console.log('wrong-filter run timed out cleanly, as expected');
  }

  console.log('SMOKE OK');
}

main().catch((error: unknown) => {
  console.error('SMOKE FAILED', error);
  process.exitCode = 1;
});
