import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from './webhook-signature.js';

function sign(secret: string, body: string, timestampSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'message.received' });

  it('accepts a signature generated the same way as the workers signer', () => {
    const now = new Date('2026-09-23T12:00:00.000Z');
    const header = sign(secret, body, Math.floor(now.getTime() / 1000));
    expect(verifyWebhookSignature({ secret, header, body, now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = new Date('2026-09-23T12:00:00.000Z');
    const header = sign(secret, body, Math.floor(now.getTime() / 1000));
    expect(
      verifyWebhookSignature({ secret, header, body: `${body}x`, now }),
    ).toBe(false);
  });

  it('rejects a timestamp older than the tolerance (default 300s)', () => {
    const now = new Date('2026-09-23T12:00:00.000Z');
    const staleSeconds = Math.floor(now.getTime() / 1000) - 301;
    const header = sign(secret, body, staleSeconds);
    expect(verifyWebhookSignature({ secret, header, body, now })).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(
      verifyWebhookSignature({ secret, header: 'not-a-signature', body, now: new Date() }),
    ).toBe(false);
  });
});
