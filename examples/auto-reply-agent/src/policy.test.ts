import { describe, expect, it } from 'vitest';

import { shouldAutoReply } from './policy.js';

function inbound(labels: string[]) {
  return { direction: 'inbound', labels };
}

describe('shouldAutoReply — real applied label sets for the 9 agentmail.md §11 fixtures', () => {
  // Recorded 2026-09-23 with JEV_ENABLED=false (rules path) by delivering each
  // fixture live over SMTP :2525 into a fresh inbox and reading back
  // `threads.list(...).labels` — not fabricated, not a claim about the live
  // Jev path (which may label ambiguous mail differently).
  const observed: Array<{ fixture: string; labels: string[]; expected: boolean }> = [
    { fixture: '01-billing-complaint.eml', labels: ['inbox', 'unread', 'billing', 'urgent', 'needs-human'], expected: false },
    { fixture: '02-otp-code.eml', labels: ['inbox', 'unread', 'otp'], expected: false },
    { fixture: '03-newsletter.eml', labels: ['inbox', 'unread', 'newsletter'], expected: false },
    { fixture: '04-phishing.eml', labels: ['inbox', 'unread', 'otp', 'spam', 'urgent'], expected: false },
    { fixture: '05-out-of-office.eml', labels: ['inbox', 'unread', 'auto'], expected: false },
    { fixture: '06-bounce.eml', labels: ['inbox', 'unread', 'auto'], expected: false },
    { fixture: '07-multipart-attachment.eml', labels: ['inbox', 'unread'], expected: false },
    { fixture: '08-long-reply-chain.eml', labels: ['inbox', 'unread'], expected: false },
    { fixture: '09-non-utf8-charset.eml', labels: ['inbox', 'unread'], expected: false },
  ];

  it.each(observed)('$fixture -> reply=$expected', ({ labels, expected }) => {
    expect(shouldAutoReply(inbound(labels))).toBe(expected);
  });

  it('replies to a support-labeled message', () => {
    expect(shouldAutoReply(inbound(['inbox', 'unread', 'support']))).toBe(true);
  });

  it('replies to billing without needs-human', () => {
    expect(shouldAutoReply(inbound(['inbox', 'unread', 'billing']))).toBe(true);
  });

  it('does not reply to billing with needs-human', () => {
    expect(shouldAutoReply(inbound(['inbox', 'unread', 'billing', 'needs-human']))).toBe(false);
  });

  it('does not reply when spam is present alongside support', () => {
    expect(shouldAutoReply(inbound(['inbox', 'unread', 'support', 'spam']))).toBe(false);
  });

  it('does not reply to outbound messages, even if labeled support', () => {
    expect(shouldAutoReply({ direction: 'outbound', labels: ['support'] })).toBe(false);
  });

  it('does not reply to skip_classify mail', () => {
    expect(shouldAutoReply(inbound(['inbox', 'unread', 'support', 'skip_classify']))).toBe(false);
  });
});
