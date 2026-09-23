import { randomBytes, scryptSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createId } from '@localmail/db';
import { requireScope } from './auth.js';
import { ApiError, errorResponses } from './errors.js';
import { decodePageCursor, encodePageCursor, paginationSchema } from './pagination.js';
import type { ApiStore, ApiKeyRow, PodRow } from './store.js';

const knownScopes = new Set(['api_keys:read', 'api_keys:write', 'drafts:read', 'drafts:write', 'inboxes:read', 'inboxes:write', 'messages:read', 'messages:send', 'messages:write', 'threads:read', 'webhooks:read', 'webhooks:write', 'ws:connect']);
const podParams = z.object({ pod_id: z.string().min(1) });
const keyParams = z.object({ id: z.string().min(1) });
const createPodBody = z.object({ name: z.string().min(1).max(200) }).strict();
const createKeyBody = z.object({ scopes: z.array(z.string().min(1)).min(1) }).strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), page_token: z.string().min(1).optional() });
const podSchema = z.object({ id: z.string(), name: z.string(), created_at: z.string().datetime() });
const keySchema = z.object({ id: z.string(), prefix: z.string(), scopes: z.array(z.string()), last_used_at: z.string().datetime().nullable(), revoked_at: z.string().datetime().nullable(), created_at: z.string().datetime() });
const createdKeySchema = keySchema.extend({ api_key: z.string() });

export function registerPodRoutes(app: FastifyInstance, store: ApiStore): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/v1/pods', { preHandler: requireScope('*'), schema: { tags: ['Pods'], operationId: 'createPod', security: [{ bearerAuth: [] }], body: createPodBody, response: { 201: z.object({ pod: podSchema, admin_api_key: z.string() }), ...errorResponses } } }, async (request, reply) => {
    const podId = createId('pod'); const raw = makeRawKey('lm_admin_');
    const pod = await store.createPod({ id: podId, name: request.body.name });
    await store.createApiKey({ id: createId('key'), podId, prefix: raw.slice(0, 12), hash: hashApiKey(raw), scopes: ['*'] });
    return reply.code(201).send({ pod: toPod(pod), admin_api_key: raw });
  });

  typed.get('/v1/pods/:pod_id', { schema: { tags: ['Pods'], operationId: 'getPod', security: [{ bearerAuth: [] }], params: podParams, response: { 200: podSchema, ...errorResponses } } }, async (request) => {
    if (request.podId !== request.params.pod_id) throw notFound();
    const pod = await store.findPodById(request.params.pod_id); if (!pod) throw notFound(); return toPod(pod);
  });

  typed.post('/v1/api-keys', { preHandler: requireScope('api_keys:write'), schema: { tags: ['API Keys'], operationId: 'createApiKey', security: [{ bearerAuth: [] }], body: createKeyBody, response: { 201: createdKeySchema, ...errorResponses } } }, async (request, reply) => {
    validateScopes(request.body.scopes);
    const raw = makeRawKey('lm_live_'); const row = await store.createApiKey({ id: createId('key'), podId: request.podId, prefix: raw.slice(0, 12), hash: hashApiKey(raw), scopes: [...new Set(request.body.scopes)] });
    return reply.code(201).send({ ...toKey(row), api_key: raw });
  });

  typed.get('/v1/api-keys', { preHandler: requireScope('api_keys:read'), schema: { tags: ['API Keys'], operationId: 'listApiKeys', security: [{ bearerAuth: [] }], querystring: listQuery, response: { 200: z.object({ data: z.array(keySchema), ...paginationSchema.shape }), ...errorResponses } } }, async (request) => {
    const cursor = request.query.page_token ? decodePageCursor(request.query.page_token) : undefined;
    const rows = await store.listApiKeys(request.podId, request.query.limit + 1, cursor ? { createdAt: cursor.sortAt, id: cursor.id } : undefined);
    const page = rows.slice(0, request.query.limit); const last = page.at(-1);
    return { data: page.map(toKey), next_page_token: rows.length > request.query.limit && last ? encodePageCursor(last.createdAt, last.id) : null };
  });

  typed.delete('/v1/api-keys/:id', { preHandler: requireScope('api_keys:write'), schema: { tags: ['API Keys'], operationId: 'revokeApiKey', security: [{ bearerAuth: [] }], params: keyParams, response: { 204: z.null(), ...errorResponses } } }, async (request, reply) => {
    const rows = await store.listApiKeys(request.podId, 1000); const existing = rows.find((row) => row.id === request.params.id);
    if (!existing) throw notFound();
    if (!existing.revokedAt && await store.countActiveApiKeys(request.podId) <= 1) throw new ApiError('validation_error', 400, 'Cannot revoke the last active key for this pod.');
    await store.revokeApiKey(request.podId, request.params.id); return reply.code(204).send(null);
  });
}

function validateScopes(scopes: string[]): void {
  if (scopes.includes('*')) throw new ApiError('validation_error', 400, 'Cannot grant the `*` scope via this endpoint; only the initial seed key holds it.');
  const unknown = scopes.find((scope) => !knownScopes.has(scope));
  if (unknown) throw new ApiError('validation_error', 400, `Unknown API scope: ${unknown}.`);
}
function makeRawKey(prefix: string): string { return `${prefix}${randomBytes(24).toString('base64url')}`; }
function hashApiKey(raw: string): string { const salt = randomBytes(16); return `scrypt:${salt.toString('base64')}:${scryptSync(raw, salt, 64).toString('base64')}`; }
function toPod(row: PodRow) { return { id: row.id, name: row.name, created_at: row.createdAt.toISOString() }; }
function toKey(row: ApiKeyRow) { return { id: row.id, prefix: row.prefix, scopes: row.scopes, last_used_at: row.lastUsedAt?.toISOString() ?? null, revoked_at: row.revokedAt?.toISOString() ?? null, created_at: row.createdAt.toISOString() }; }
function notFound(): ApiError { return new ApiError('not_found', 404, 'The requested resource was not found.'); }
