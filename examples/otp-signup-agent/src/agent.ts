import type { Inbox, WaitForEmailOptions } from '@localmail/sdk';

import { extractCode } from './extract-code.js';
import type { FakeSignupService } from './fake-signup-service.js';

export interface SignupSdk {
  inboxes: {
    create(input: { client_id?: string }): Promise<Inbox>;
  };
  waitForEmail(inboxId: string, options: WaitForEmailOptions): Promise<{ extracted_text: string | null }>;
}

export interface SignupOptions {
  clientId?: string;
  timeoutMs?: number;
  /** Send the signup email *before* calling waitForEmail — exercises the SDK's catch-up path. */
  race?: boolean;
  /** Deliberately wrong sender filter, to exercise a clean timeout. */
  fromOverride?: string;
}

export interface SignupResult {
  inbox: Inbox;
  verified: boolean;
  elapsedMs: number;
}

/**
 * `inboxes.create({client_id})` → capture `since` → trigger signup →
 * `waitForEmail(..., {from, since})` → `extractCode` → `service.verify(code)`.
 * A real agent would call an LLM only to draft copy elsewhere in a larger
 * flow; there is no LLM call anywhere in this path (agentmail.md §10 task 21).
 */
export async function signupAndVerify(
  sdk: SignupSdk,
  service: FakeSignupService,
  options: SignupOptions = {},
): Promise<SignupResult> {
  const inbox = await sdk.inboxes.create({ client_id: options.clientId });
  const since = new Date();
  const from = options.fromOverride ?? 'auth.example.com';
  const start = Date.now();

  if (options.race) {
    await service.signup(inbox.address);
  }

  const waitPromise = sdk.waitForEmail(inbox.id, {
    from,
    since,
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  if (!options.race) {
    await service.signup(inbox.address);
  }

  const message = await waitPromise;
  const code = extractCode(message.extracted_text);
  const verified = code !== null && service.verify(code);
  return { inbox, verified, elapsedMs: Date.now() - start };
}
