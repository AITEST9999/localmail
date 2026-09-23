export async function mailpitTotal(): Promise<number> {
  const url = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
  const response = await fetch(`${url}/api/v1/messages?limit=1`);
  if (!response.ok) throw new Error(`Mailpit query failed: ${response.status}`);
  const body = (await response.json()) as { total: number };
  return body.total;
}
