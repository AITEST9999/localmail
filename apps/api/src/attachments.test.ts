import { describe, expect, it } from 'vitest';

import type { ApiError } from './errors.js';
import { readAttachmentStream } from './attachments.js';

describe('attachment upload streaming limit', () => {
  it('stops consuming as soon as the byte limit is crossed', async () => {
    let chunksProduced = 0;
    const values = [Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(100)];
    const chunks: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next() {
            const value = values[index];
            index += 1;
            if (!value) return Promise.resolve({ done: true, value: undefined });
            chunksProduced += 1;
            return Promise.resolve({ done: false, value });
          },
        };
      },
    };

    await expect(
      readAttachmentStream(chunks, 5),
    ).rejects.toMatchObject({
      code: 'payload_too_large',
      statusCode: 413,
    } satisfies Partial<ApiError>);
    expect(chunksProduced).toBe(2);
  });
});
