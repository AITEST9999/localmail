import { scryptSync, timingSafeEqual } from 'node:crypto';

import fp from 'fastify-plugin';
import type { preHandlerHookHandler } from 'fastify';

import { ApiError } from './errors.js';
import type { ApiKeyRow, ApiStore } from './store.js';
import type { RateLimiter } from './rate-limit.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyRow: ApiKeyRow;
    podId: string;
  }
}

export interface AuthPluginOptions {
  store: ApiStore;
  rateLimiter?: RateLimiter;
  onRateLimited?: (scope: 'key' | 'pod') => void;
}

export const authPlugin = fp<AuthPluginOptions>((app, { store, rateLimiter, onRateLimited }, done) => {
  app.decorateRequest('apiKeyRow');
  app.decorateRequest('podId');

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/')) return;

    const rawKey = parseBearerKey(request.headers.authorization);
    if (!rawKey) {
      throw new ApiError(
        'missing_authorization',
        401,
        'Authorization header must use the Bearer scheme.',
      );
    }

    const row = await store.findApiKeyByPrefix(rawKey.slice(0, 12));
    if (!row || row.revokedAt || !verifyScryptHash(rawKey, row.hash)) {
      throw new ApiError('invalid_api_key', 401, 'Invalid API key.');
    }

    request.apiKeyRow = row;
    request.podId = row.podId;

    void store.touchApiKey(row.id).catch((error: unknown) => {
      request.log.warn(
        { err: error, apiKeyId: row.id },
        'failed to update API key usage',
      );
    });
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!rateLimiter || !request.url.startsWith('/v1/')) return;
    const result = await rateLimiter.consume(request.podId, request.apiKeyRow.id);
    if (!result.allowed) {
      reply.header('Retry-After', String(result.retryAfterSeconds));
      onRateLimited?.(result.scope ?? 'key');
      throw new ApiError('rate_limited', 429, 'Rate limit exceeded.');
    }
  });
  done();
});

export function requireScope(requiredScope: string): preHandlerHookHandler {
  return (request, _reply, done) => {
    const scopes = request.apiKeyRow.scopes;
    if (!scopes.includes('*') && !scopes.includes(requiredScope)) {
      return done(
        new ApiError(
          'insufficient_scope',
          403,
          `API key requires the ${requiredScope} scope.`,
        ),
      );
    }
    done();
  };
}

export function verifyScryptHash(rawKey: string, storedHash: string): boolean {
  const [algorithm, encodedSalt, encodedDerived, ...extra] =
    storedHash.split(':');
  if (
    algorithm !== 'scrypt' ||
    !encodedSalt ||
    !encodedDerived ||
    extra.length > 0
  )
    return false;

  try {
    const expected = Buffer.from(encodedDerived, 'base64');
    const actual = scryptSync(rawKey, Buffer.from(encodedSalt, 'base64'), 64);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

function parseBearerKey(authorization: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
  return match?.[1] ?? null;
}
