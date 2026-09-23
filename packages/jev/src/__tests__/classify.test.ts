import { describe, expect, it } from 'vitest';

import { classify } from '../classify.js';
import { classifyWithRules } from '../rules.js';
import { labelsFromAnswers } from '../types.js';

describe('classifyWithRules (P3-15)', () => {
  it('labels §9 billing smoke as billing + urgent + needs-human', () => {
    const answers = classifyWithRules({
      from: 'alice@example.com',
      subject: 'I was charged twice!',
      extractedText: 'Please refund ASAP.',
      text: 'Please refund ASAP.',
    });
    expect(answers.source).toBe('rules');
    expect(answers.category.chosen).toBe('billing');
    expect(answers.urgent.verdict).toBe('yes');
    expect(answers.needsHuman.verdict).toBe('yes');
    expect(answers.spam.verdict).toBe('no');
    expect(answers.auto.verdict).toBe('no');
    expect(labelsFromAnswers(answers)).toEqual(
      expect.arrayContaining(['billing', 'urgent', 'needs-human']),
    );
  });

  it('classifies OTP without auto', () => {
    const answers = classifyWithRules({
      from: 'noreply@auth.example.com',
      subject: 'Your verification code is 482913',
      extractedText: 'Your one-time verification code is 482913.',
      text: null,
    });
    expect(answers.category.chosen).toBe('otp');
    expect(answers.auto.verdict).toBe('no');
  });

  it('classifies newsletter', () => {
    const answers = classifyWithRules({
      from: 'digest@news.example.com',
      subject: 'This week in product updates',
      extractedText: 'Here is your weekly newsletter. Unsubscribe anytime.',
      text: null,
    });
    expect(answers.category.chosen).toBe('newsletter');
  });

  it('flags phishing as spam', () => {
    const answers = classifyWithRules({
      from: 'secure@paypa1-security.example',
      subject: 'Urgent: confirm your account or it will be locked',
      extractedText:
        'Click here immediately to verify your password and credit card.',
      text: null,
    });
    expect(answers.spam.verdict).toBe('yes');
  });

  it('marks bounce/OOO as auto via heuristics', () => {
    const bounce = classifyWithRules({
      from: 'MAILER-DAEMON@mail.example.com',
      subject: 'Undelivered Mail Returned to Sender',
      extractedText: 'Your message could not be delivered.',
      text: null,
      autoSubmitted: 'auto-replied',
    });
    expect(bounce.auto.verdict).toBe('yes');

    const ooo = classifyWithRules({
      from: 'bob@example.com',
      subject: 'Out of Office',
      extractedText: 'I am out of the office until Monday.',
      text: null,
    });
    expect(ooo.auto.verdict).toBe('yes');
  });
});

describe('classify() branching', () => {
  it('uses rules when JEV_ENABLED is false', async () => {
    const result = await classify(
      {
        from: 'alice@example.com',
        subject: 'I was charged twice!',
        extractedText: 'Please refund ASAP.',
        text: null,
      },
      { jevEnabled: false },
    );
    expect(result.answers.source).toBe('rules');
    expect(result.labels).toEqual(
      expect.arrayContaining(['billing', 'urgent']),
    );
  });

  it('falls back to rules when the live client throws', async () => {
    const result = await classify(
      {
        from: 'alice@example.com',
        subject: 'I was charged twice!',
        extractedText: 'Please refund ASAP.',
        text: null,
      },
      {
        jevEnabled: true,
        apiKey: 'test-key',
        client: {
          systemOne: () => Promise.reject(new Error('network down')),
        } as never,
      },
    );
    expect(result.answers.source).toBe('rules');
    expect(result.labels).toContain('billing');
  });
});
