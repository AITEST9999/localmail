import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { LOG_REDACT_PATHS } from './logging.js';

describe('logging redaction', () => {
  it('never emits bearer keys or secret fields', () => {
    const chunks: string[] = [];
    const logger = pino({ redact: [...LOG_REDACT_PATHS] }, { write: (chunk: string) => chunks.push(chunk) });
    logger.info({ req: { headers: { authorization: 'Bearer lm_admin_super-secret' } }, api_key: 'lm_admin_super-secret', secret: 'hook-secret' }, 'sentinel');
    const output = chunks.join('');
    expect(output).not.toContain('lm_admin_super-secret');
    expect(output).not.toContain('hook-secret');
    expect(output).toContain('[Redacted]');
  });
});
