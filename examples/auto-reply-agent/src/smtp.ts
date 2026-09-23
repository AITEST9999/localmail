import { execFile, type ExecFileException } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SMTP_URL = process.env.SMTP_URL ?? 'smtp://127.0.0.1:2525';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error: ExecFileException | null) => {
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

/** Delivers an existing `.eml` file over SMTP, envelope `--mail-rcpt` decides the inbox. */
export async function deliverFixture(path: string, to: string, from = 'customer@example.com'): Promise<void> {
  await run('curl', ['-s', SMTP_URL, '--mail-from', from, '--mail-rcpt', to, '--upload-file', path]);
}

/** Builds a minimal RFC 822 message and delivers it, for content this example needs that isn't in fixtures/emails. */
export async function deliverRaw(input: {
  to: string;
  from?: string;
  subject: string;
  text: string;
}): Promise<void> {
  const from = input.from ?? 'customer@example.com';
  const raw =
    `From: ${from}\r\n` +
    `To: ${input.to}\r\n` +
    `Subject: ${input.subject}\r\n` +
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@example.com>\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    `${input.text}\r\n`;
  const path = join(tmpdir(), `localmail-example-${Date.now()}-${Math.random().toString(36).slice(2)}.eml`);
  await writeFile(path, raw, 'utf8');
  try {
    await deliverFixture(path, input.to, from);
  } finally {
    await unlink(path);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
