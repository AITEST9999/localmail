import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verifies the `t=<seconds>,v1=<hex>` signature scheme LocalMail webhooks
 * use (matches apps/workers/src/signature.ts — vectors are copied, not
 * imported, so the SDK keeps zero @localmail/* dependencies per Decision 2.4).
 */
export function verifyWebhookSignature(options: {
  secret: string;
  header: string;
  body: string;
  toleranceSec?: number;
  now?: Date;
}): boolean {
  const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(options.header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  const signature = match[2]!;
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const expected = createHmac('sha256', options.secret)
    .update(`${timestamp}.${options.body}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const suppliedBuf = Buffer.from(signature, 'hex');
  return (
    expectedBuf.length === suppliedBuf.length && timingSafeEqual(expectedBuf, suppliedBuf)
  );
}
