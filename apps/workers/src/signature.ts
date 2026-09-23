import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

export interface WebhookEnvelope {
  id: string;
  type: string;
  created_at: string;
  pod_id: string;
  data: Record<string, unknown>;
}

export function buildWebhookBody(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope);
}

export function signWebhookBody(
  secret: string,
  body: string,
  timestampSeconds: number,
): string {
  const signedString = `${timestampSeconds}.${body}`;
  const v1 = createHmac('sha256', secret).update(signedString).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

/** agentmail.md §11 verify steps — used by delivery tests. */
export function verifyWebhookSignature(options: {
  secret: string;
  signatureHeader: string;
  rawBody: string;
  nowUnixSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const tolerance =
    options.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(options.signatureHeader);
  if (!match) return false;
  const t = Number(match[1]);
  const v1 = match[2]!;
  if (!Number.isFinite(t)) return false;
  if (Math.abs(options.nowUnixSeconds - t) > tolerance) return false;

  const expected = createHmac('sha256', options.secret)
    .update(`${t}.${options.rawBody}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const suppliedBuf = Buffer.from(v1, 'hex');
  return (
    expectedBuf.length === suppliedBuf.length &&
    timingSafeEqual(expectedBuf, suppliedBuf)
  );
}
