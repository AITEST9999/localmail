export interface MailpitSummary {
  total: number;
}

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

export async function mailpitTotal(): Promise<number> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=1`);
  if (!response.ok) throw new Error(`Mailpit query failed: ${response.status}`);
  const body = (await response.json()) as MailpitSummary;
  return body.total;
}
