import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { encryptSecret } from '@localmail/core';
import { createId } from '@localmail/db';
import { requireScope } from './auth.js';
import { ApiError, errorResponses } from './errors.js';
import { decodePageCursor, encodePageCursor, paginationSchema } from './pagination.js';
import type { ApiStore, DomainRow } from './store.js';

const domainName = z.string().min(1).max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, 'Must be a valid hostname.');
const createBody = z.object({ domain: domainName }).strict();
const verifyBody = z.object({ dns_records: z.record(z.unknown()) }).strict();
const params = z.object({ id: z.string().min(1) });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), page_token: z.string().min(1).optional() });
const response = z.object({ id: z.string(), domain: z.string(), status: z.enum(['pending', 'verified', 'failed']), dns_records: z.record(z.unknown()), created_at: z.string().datetime() });

export function registerDomainRoutes(app: FastifyInstance, store: ApiStore, encryptionKey: Buffer, mailDomain: string): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/v1/domains', { preHandler: requireScope('domains:write'), schema: { tags: ['Domains'], operationId: 'createDomain', security: [{ bearerAuth: [] }], body: createBody, response: { 201: response, ...errorResponses } } }, async (request, reply) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const publicValue = publicKey.replace(/-----[^-]+-----/g, '').replaceAll(/\s+/g, '');
    const dnsRecords = { mx: { type: 'MX', host: '@', value: mailDomain, priority: 10 }, spf: { type: 'TXT', host: '@', value: `v=spf1 include:${mailDomain} ~all` }, dkim: { type: 'TXT', host: 'lm1._domainkey', value: `v=DKIM1; k=rsa; p=${publicValue}` }, dmarc: { type: 'TXT', host: '_dmarc', value: `v=DMARC1; p=none; rua=mailto:dmarc@${mailDomain}` } };
    const row = await store.createDomain({ id: createId('dom'), podId: request.podId, domain: request.body.domain.toLowerCase(), status: 'pending', dkimPrivateKey: encryptSecret(privateKey, encryptionKey), dnsRecords });
    return reply.code(201).send(toResponse(row));
  });
  typed.get('/v1/domains', { preHandler: requireScope('domains:read'), schema: { tags: ['Domains'], operationId: 'listDomains', security: [{ bearerAuth: [] }], querystring: listQuery, response: { 200: z.object({ data: z.array(response), ...paginationSchema.shape }), ...errorResponses } } }, async (request) => {
    const cursor = request.query.page_token ? decodePageCursor(request.query.page_token) : undefined; const rows = await store.listDomains(request.podId, request.query.limit + 1, cursor ? { createdAt: cursor.sortAt, id: cursor.id } : undefined); const page = rows.slice(0, request.query.limit); const last = page.at(-1);
    return { data: page.map(toResponse), next_page_token: rows.length > request.query.limit && last ? encodePageCursor(last.createdAt, last.id) : null };
  });
  typed.get('/v1/domains/:id', { preHandler: requireScope('domains:read'), schema: { tags: ['Domains'], operationId: 'getDomain', security: [{ bearerAuth: [] }], params, response: { 200: response, ...errorResponses } } }, async (request) => { const row = await store.findDomainById(request.podId, request.params.id); if (!row) throw notFound(); return toResponse(row); });
  typed.delete('/v1/domains/:id', { preHandler: requireScope('domains:write'), schema: { tags: ['Domains'], operationId: 'deleteDomain', security: [{ bearerAuth: [] }], params, response: { 204: z.null(), ...errorResponses } } }, async (request, reply) => { if (!(await store.deleteDomain(request.podId, request.params.id))) throw notFound(); return reply.code(204).send(null); });
  typed.post('/v1/domains/:id/verify', { preHandler: requireScope('domains:write'), schema: { tags: ['Domains'], operationId: 'verifyDomain', security: [{ bearerAuth: [] }], params, body: verifyBody, response: { 200: response, ...errorResponses } } }, async (request) => { const row = await store.findDomainById(request.podId, request.params.id); if (!row) throw notFound(); const expected = row.dnsRecords.dkim as { host?: unknown; value?: unknown } | undefined; const actual = request.body.dns_records.dkim as { host?: unknown; value?: unknown } | undefined; const status = expected && actual && expected.host === actual.host && expected.value === actual.value ? 'verified' : 'failed'; const updated = await store.updateDomainStatus(request.podId, row.id, status); return toResponse(updated ?? { ...row, status }); });
}
export function toResponse(row: DomainRow) { return { id: row.id, domain: row.domain, status: row.status, dns_records: row.dnsRecords, created_at: row.createdAt.toISOString() }; }
function notFound(): ApiError { return new ApiError('not_found', 404, 'The requested domain was not found.'); }
