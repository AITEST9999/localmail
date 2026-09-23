import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/emails',
);

const EXPECTED_FIXTURES = [
  '01-billing-complaint.eml',
  '02-otp-code.eml',
  '03-newsletter.eml',
  '04-phishing.eml',
  '05-out-of-office.eml',
  '06-bounce.eml',
  '07-multipart-attachment.eml',
  '08-long-reply-chain.eml',
  '09-non-utf8-charset.eml',
] as const;

describe('fixtures/emails parse smoke (X-2)', () => {
  it('lists the nine agentmail.md §11 cases', async () => {
    const entries = (await readdir(FIXTURES_DIR)).filter((name) =>
      name.endsWith('.eml'),
    );
    expect(entries.sort()).toEqual([...EXPECTED_FIXTURES]);
  });

  it('parses every fixture with mailparser without throwing', async () => {
    for (const name of EXPECTED_FIXTURES) {
      const raw = await readFile(path.join(FIXTURES_DIR, name));
      const parsed = await simpleParser(raw);
      expect(parsed.messageId, name).toBeTruthy();
      expect(
        parsed.subject ?? parsed.text ?? parsed.html,
        `${name} should expose subject or body`,
      ).toBeTruthy();
    }
  });

  it('billing complaint matches §9 smoke spirit', async () => {
    const raw = await readFile(
      path.join(FIXTURES_DIR, '01-billing-complaint.eml'),
    );
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe('I was charged twice!');
    expect(parsed.text).toMatch(/refund ASAP/i);
  });

  it('multipart fixture exposes an attachment', async () => {
    const raw = await readFile(
      path.join(FIXTURES_DIR, '07-multipart-attachment.eml'),
    );
    const parsed = await simpleParser(raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('note.txt');
    expect(parsed.attachments[0]?.content.toString('utf8')).toBe(
      'attachment body',
    );
  });

  it('long reply chain carries References matching P1-7 atlas fixtures', async () => {
    const raw = await readFile(
      path.join(FIXTURES_DIR, '08-long-reply-chain.eml'),
    );
    const parsed = await simpleParser(raw);
    expect(parsed.messageId).toContain('atlas-4@localmail.test');
    expect(parsed.inReplyTo).toContain('atlas-3@localmail.test');
    const references = Array.isArray(parsed.references)
      ? parsed.references.join(' ')
      : (parsed.references ?? '');
    expect(references).toContain('atlas-1@localmail.test');
    expect(references).toContain('atlas-2@localmail.test');
    expect(references).toContain('atlas-3@localmail.test');
  });

  it('non-UTF-8 charset decodes latin1 subject/body', async () => {
    const raw = await readFile(
      path.join(FIXTURES_DIR, '09-non-utf8-charset.eml'),
    );
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe('Café résumé');
    expect(parsed.text).toMatch(/déjà vu/);
  });
});
