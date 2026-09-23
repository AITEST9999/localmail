import { describe, expect, it } from 'vitest';

import { normalizeSubject } from '../index.js';

describe('normalizeSubject', () => {
  it('strips nested reply and forward prefixes case-insensitively', () => {
    expect(normalizeSubject('Re: Hello World')).toBe('hello world');
    expect(normalizeSubject('FW: Re: Hello')).toBe('hello');
    expect(normalizeSubject(' fWd: RE[3]: Status Update ')).toBe('status update');
  });

  it('collapses insignificant whitespace', () => {
    expect(normalizeSubject('  Re:  Quarterly\t   planning  ')).toBe('quarterly planning');
  });

  it('does not strip mailing-list tags or localized prefixes', () => {
    expect(normalizeSubject('Re: [engineering] Deploy')).toBe('[engineering] deploy');
    expect(normalizeSubject('Aw: Deploy')).toBe('aw: deploy');
  });
});
