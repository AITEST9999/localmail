import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireScope } from './auth.js';
import { ApiError, errorResponses } from './errors.js';
import { decodeSearchCursor, encodeSearchCursor, paginationSchema } from './pagination.js';
import { messageSummarySchema, toMessageSummary } from './messages.js';
import type { ApiStore } from './store.js';
import { embed } from '@localmail/embeddings';

const querySchema = z.object({ q: z.string().min(1).refine((value) => value.trim().length > 0, 'Search query must not be blank.'), mode: z.enum(['fts', 'semantic']).default('fts'), inbox_id: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), page_token: z.string().min(1).optional() });
const searchSummarySchema = messageSummarySchema.extend({ rank: z.number(), mode: z.enum(['fts', 'semantic']) });

export function registerSearchRoutes(app: FastifyInstance, store: ApiStore): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/v1/search', { preHandler: requireScope('messages:read'), schema: { tags: ['Search'], operationId: 'searchMessages', security: [{ bearerAuth: [] }], querystring: querySchema, response: { 200: z.object({ data: z.array(searchSummarySchema), ...paginationSchema.shape }), ...errorResponses } } }, async (request) => {
    if (request.query.inbox_id && !(await store.findInboxById(request.podId, request.query.inbox_id))) throw new ApiError('not_found', 404, 'The requested inbox was not found.');
    const cursor = request.query.page_token ? decodeSearchCursor(request.query.page_token) : undefined;
    if (cursor?.mode && cursor.mode !== request.query.mode) throw new ApiError('validation_error', 400, 'Search page token mode does not match the requested mode.', [{ path: 'page_token', message: 'cursor mode mismatch' }]);
    const rows = request.query.mode === 'semantic'
      ? await store.searchMessagesSemantic(request.podId, await embed(request.query.q.trim()), request.query.inbox_id, request.query.limit + 1, cursor)
      : await store.searchMessages(request.podId, request.query.q.trim(), request.query.inbox_id, request.query.limit + 1, cursor);
    const page = rows.slice(0, request.query.limit); const last = page.at(-1);
    return { data: page.map(({ message, rank }) => ({ ...toMessageSummary(message), rank, mode: request.query.mode })), next_page_token: rows.length > request.query.limit && last ? encodeSearchCursor(last.rank, last.message.id, request.query.mode) : null };
  });
}
