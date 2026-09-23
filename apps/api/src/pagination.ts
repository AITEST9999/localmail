import { z } from 'zod';

import { ApiError } from './errors.js';

export interface PageCursor {
  sortAt: Date;
  id: string;
}
export interface SearchCursor { rank: number; id: string; mode?: 'fts' | 'semantic' }

/** Documents the `next_page_token` shape shared by every paginated list response. */
export const paginationSchema = z.object({
  next_page_token: z.string().nullable(),
});

const cursorSchema = z
  .object({
    v: z.literal(1),
    sort_key: z.string().datetime(),
    id: z.string().min(1),
  })
  .strict();

export function encodePageCursor(sortAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, sort_key: sortAt.toISOString(), id }),
  ).toString('base64url');
}

export function decodePageCursor(token: string): PageCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid encoding');
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = cursorSchema.parse(JSON.parse(decoded) as unknown);
    if (Buffer.from(decoded).toString('base64url') !== token)
      throw new Error('non-canonical encoding');
    return { sortAt: new Date(parsed.sort_key), id: parsed.id };
  } catch {
    throw new ApiError(
      'validation_error',
      400,
      'Request validation failed.',
      [{ path: 'page_token', message: 'invalid or expired page token' }],
    );
  }
}

export function encodeSearchCursor(rank: number, id: string, mode: 'fts' | 'semantic' = 'fts'): string {
  return Buffer.from(JSON.stringify({ v: 1, rank, id, mode })).toString('base64url');
}

export function decodeSearchCursor(token: string): SearchCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid encoding');
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as { v?: unknown; rank?: unknown; id?: unknown; mode?: unknown };
    if (parsed.v !== 1 || typeof parsed.rank !== 'number' || !Number.isFinite(parsed.rank) || typeof parsed.id !== 'string' || !parsed.id || (parsed.mode !== undefined && parsed.mode !== 'fts' && parsed.mode !== 'semantic') || Buffer.from(decoded).toString('base64url') !== token) throw new Error('invalid cursor');
    return { rank: parsed.rank, id: parsed.id, mode: parsed.mode };
  } catch {
    throw new ApiError('validation_error', 400, 'Request validation failed.', [{ path: 'page_token', message: 'invalid or expired page token' }]);
  }
}
