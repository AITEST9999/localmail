import { createHash } from 'node:crypto';

import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';

import { ApiError } from './errors.js';
import type { ApiStore, IdempotencyRecord } from './store.js';

interface IdempotencyContext {
  endpoint: string;
  key: string;
  requestHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyContext?: IdempotencyContext;
    idempotencyReplay: boolean;
  }
}

export interface IdempotencyPluginOptions {
  store: ApiStore;
}

export const idempotencyPlugin = fp<IdempotencyPluginOptions>(
  (app, { store }, done) => {
    app.decorateRequest('idempotencyContext');
    app.decorateRequest('idempotencyReplay', false);

    app.addHook('preHandler', async (request, reply) => {
      if (request.method !== 'POST' || !request.url.startsWith('/v1/')) return;

      const key = readIdempotencyKey(request);
      if (!key) return;

      const endpoint = request.url.split('?', 1)[0] ?? request.url;
      const requestHash = hashRequest(
        request.method,
        endpoint,
        request.idempotencyBody ?? request.body,
      );
      const existing = await store.findIdempotencyRecord(request.podId, key);

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ApiError(
            'idempotency_key_reused',
            409,
            'The Idempotency-Key was already used with a different request body.',
          );
        }

        request.idempotencyReplay = true;
        await reply
          .header('Idempotency-Replay', 'true')
          .code(existing.responseStatus)
          .send(existing.responseBody);
        return;
      }

      request.idempotencyContext = { endpoint, key, requestHash };
    });

    app.addHook('onSend', async (request, reply, payload) => {
      if (
        !request.idempotencyContext ||
        request.idempotencyReplay ||
        reply.statusCode < 200 ||
        reply.statusCode >= 300
      ) {
        return payload;
      }

      const responseBody = parseResponseBody(payload);
      if (!responseBody) return payload;

      const record: IdempotencyRecord = {
        podId: request.podId,
        ...request.idempotencyContext,
        responseStatus: reply.statusCode,
        responseBody,
      };
      await store.saveIdempotencyRecord(record);
      return payload;
    });
    done();
  },
);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashRequest(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method}:${path}:${canonicalJson(body ?? null)}`)
    .digest('hex');
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError('validation_error', 400, 'Request validation failed.', [
      { path: 'Idempotency-Key', message: 'must be a non-empty string' },
    ]);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function parseResponseBody(payload: unknown): Record<string, unknown> | null {
  try {
    const parsed =
      typeof payload === 'string'
        ? (JSON.parse(payload) as unknown)
        : Buffer.isBuffer(payload)
          ? (JSON.parse(payload.toString('utf8')) as unknown)
          : payload;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
