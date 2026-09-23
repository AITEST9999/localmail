import { describe, expect, it } from 'vitest';

import { extractCode } from './extract-code.js';

// Body text of fixtures/emails/02-otp-code.eml, verified 2026-09-23.
const FIXTURE_BODY =
  'Your one-time verification code is 482913. It expires in 10 minutes.\n' +
  'Do not share this code with anyone.';

describe('extractCode', () => {
  it('extracts the code from fixtures/emails/02-otp-code.eml', () => {
    expect(extractCode(FIXTURE_BODY)).toBe('482913');
  });

  it('extracts a code regardless of surrounding wording', () => {
    expect(extractCode('Use 019283 to sign in.')).toBe('019283');
  });

  it('returns null when there is no 6-digit code', () => {
    expect(extractCode('Welcome! Click the link to confirm your account.')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(extractCode(null)).toBeNull();
    expect(extractCode(undefined)).toBeNull();
  });
});
