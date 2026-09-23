import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../crypto.js';

describe('encrypted secrets', () => {
  it.each(['DKIM private key', 'webhook signing secret'])(
    'round-trips a %s using authenticated encryption',
    (secret) => {
      const key = randomBytes(32);
      const encrypted = encryptSecret(secret, key);

      expect(encrypted).not.toContain(secret);
      expect(decryptSecret(encrypted, key)).toBe(secret);
    },
  );

  it('rejects ciphertext tampering', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('sensitive', key);
    const tampered = `${encrypted.slice(0, -2)}AA`;

    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});
