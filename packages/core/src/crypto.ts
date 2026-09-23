import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 'v1';

export function decodeEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  assertKeyLength(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, iv, authTag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  assertKeyLength(key);
  const [version, encodedIv, encodedAuthTag, encodedCiphertext, ...extra] = payload.split(':');
  if (
    version !== VERSION ||
    !encodedIv ||
    !encodedAuthTag ||
    !encodedCiphertext ||
    extra.length > 0
  ) {
    throw new Error('Encrypted secret has an unsupported or malformed format.');
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encodedIv, 'base64'));
  decipher.setAuthTag(Buffer.from(encodedAuthTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error('Encryption key must be exactly 32 bytes.');
  }
}
