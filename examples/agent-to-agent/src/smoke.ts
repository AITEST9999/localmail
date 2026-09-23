import { LocalMail } from '@localmail/sdk';

import { mailpitTotal } from './mailpit.js';
import { runNegotiation } from './negotiate.js';
import { runRunaway } from './runaway.js';

async function runNormal(sdk: LocalMail): Promise<void> {
  const before = await mailpitTotal();
  const result = await runNegotiation(sdk);
  const after = await mailpitTotal();

  console.log(
    `negotiated ${result.chosenSlot.id} (${result.chosenSlot.label}) in ${result.messageCount} message(s)`,
  );
  console.log(`alice thread: ${result.aliceThreadId}  bob thread: ${result.bobThreadId}`);
  console.log(`Mailpit total: ${before} -> ${after} (expected unchanged — pure loopback)`);

  if (result.messageCount > 4) throw new Error('Expected the negotiation to finish in <= 4 messages.');
  if (after !== before) throw new Error('Pure loopback must not touch Mailpit.');
}

async function runRunawayMode(sdk: LocalMail): Promise<void> {
  const configuredMax = Number(process.env.SMTP_MAX_HOPS ?? 20);
  const result = await runRunaway(sdk);
  console.log(`--runaway stopped itself at hop ${result.hopsReached} (configured max: ${configuredMax})`);
  if (result.hopsReached < 1) throw new Error('Expected at least one hop before the guard tripped.');
}

async function main(): Promise<void> {
  const sdk = new LocalMail();
  const runaway = process.argv.includes('--runaway');

  if (runaway) {
    await runRunawayMode(sdk);
  } else {
    await runNormal(sdk);
  }

  console.log('SMOKE OK');
}

main().catch((error: unknown) => {
  console.error('SMOKE FAILED', error);
  process.exitCode = 1;
});
