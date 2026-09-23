import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createJsonSchemaTransformObject,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type FastifyPluginCallbackZod,
  type FastifyPluginAsyncZod,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Env } from '@localmail/config';
import {
  createInboundIngestor,
  createS3ObjectStore,
  decodeEncryptionKey,
  decryptSecret,
  noopMessageEventPublisher,
  type MessageEventPublisher,
  type RawObjectReader,
} from '@localmail/core';
import { createDatabase } from '@localmail/db';
import type { Redis } from 'ioredis';
import {
  createDurableEventPublisher,
  createRedisConnection,
  createRedisSubscriber,
} from '@localmail/events';

import { authPlugin } from './auth.js';
import {
  createAttachmentUrlSigner,
  MAX_ATTACHMENT_BYTES,
  type AttachmentUrlSigner,
} from './attachments.js';
import {
  ApiError,
  errorResponses,
  errorResponseSchema,
  toErrorBody,
  toValidationError,
  type ErrorBody,
} from './errors.js';
import { idempotencyPlugin } from './idempotency.js';
import { inboxResponseSchema, registerInboxRoutes } from './inboxes.js';
import { draftResponseSchema, registerDraftRoutes } from './drafts.js';
import {
  messageResponseSchema,
  messageSummarySchema,
  registerMessageRoutes,
  threadSummarySchema,
} from './messages.js';
import {
  createNodemailerOutboundTransport,
  createOutboundMessageService,
  type OutboundMessageService,
} from './outbound.js';
import { paginationSchema } from './pagination.js';
import { createDrizzleApiStore, type ApiStore } from './store.js';
import {
  deliveryResponseSchema,
  registerWebhookRoutes,
  webhookResponseSchema,
  type WebhookTestFire,
} from './webhooks.js';
import { registerWsRoutes } from './ws.js';
import { createRedisRateLimiter } from './rate-limit.js';
import { registerPodRoutes } from './pods.js';
import { registerSearchRoutes } from './search.js';
import { registerDomainRoutes } from './domains.js';
import { httpDuration, httpRequests, metricsRegistry, rateLimited } from './metrics.js';
import { LOG_REDACT_PATHS } from './logging.js';

export interface CreateAppOptions {
  logger?: boolean;
  registerRoutes?: FastifyPluginAsyncZod | FastifyPluginCallbackZod;
  store?: ApiStore;
  outbound?: OutboundMessageService;
  eventPublisher?: MessageEventPublisher;
  webhookTestFire?: WebhookTestFire;
  encryptionKey?: Buffer;
  rawObjectReader?: RawObjectReader;
  attachmentUrlSigner?: AttachmentUrlSigner;
  /** Dedicated subscribe-mode Redis for WS hub. Pass null to disable /v1/ws. */
  wsSubscriber?: Redis | null;
}

const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('localmail-api'),
  timestamp: z.string().datetime(),
});

const meResponseSchema = z.object({
  pod_id: z.string(),
  api_key_id: z.string(),
  scopes: z.array(z.string()),
});

export function createApp(
  env: Env,
  options: CreateAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger === false ? false : { redact: [...LOG_REDACT_PATHS] },
  }).withTypeProvider<ZodTypeProvider>();

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequests.inc(labels); httpDuration.observe(labels, (reply.elapsedTime ?? 0) / 1000);
  });
  app.get('/metrics', async (_request, reply) => reply.type(metricsRegistry.contentType).send(await metricsRegistry.metrics()));

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES + 1,
      files: 20,
      fields: 1,
      parts: 21,
      fieldSize: 1024 * 1024,
    },
  });

  const ownedDatabase = options.store ? null : createDatabase(env.DATABASE_URL);
  const store = options.store ?? createDrizzleApiStore(ownedDatabase!.db);
  if (ownedDatabase) {
    app.addHook('onClose', async () => ownedDatabase.close());
  }

  const ownedPublisher =
    options.eventPublisher || options.outbound || !ownedDatabase
      ? null
      : (() => {
          const redis = createRedisConnection(env.REDIS_URL);
          const publisher = createDurableEventPublisher(ownedDatabase.db, redis);
          app.addHook('onClose', async () => {
            await publisher.close();
            redis.disconnect();
          });
          return publisher;
        })();
  const eventPublisher =
    options.eventPublisher ?? ownedPublisher ?? noopMessageEventPublisher;
  const webhookTestFire: WebhookTestFire | null =
    options.webhookTestFire ?? ownedPublisher;
  const encryptionKey =
    options.encryptionKey ??
    (env.APP_ENCRYPTION_KEY
      ? decodeEncryptionKey(env.APP_ENCRYPTION_KEY)
      : null);

  const objectStorage =
    !options.outbound || !options.rawObjectReader
      ? createS3ObjectStore({
          endpoint: env.S3_ENDPOINT,
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
          bucket: env.S3_BUCKET,
        })
      : null;
  const rawObjectReader = options.rawObjectReader ?? objectStorage!.store;
  let outbound = options.outbound;
  if (!outbound) {
    const transport = createNodemailerOutboundTransport({
      host: env.SMTP_OUTBOUND_HOST,
      port: env.SMTP_OUTBOUND_PORT,
    });
    const ingestor = createInboundIngestor({
      mailDomain: env.MAIL_DOMAIN,
      repository: store,
      objectStore: objectStorage!.store,
      eventPublisher,
    });
    outbound = createOutboundMessageService({
      store,
      objectStore: objectStorage!.store,
      ingestor,
      transport,
      mailDomain: env.MAIL_DOMAIN,
      maximumHopCount: env.SMTP_MAX_HOPS,
      eventPublisher,
      dkimResolver: async (sender) => {
        const domain = await store.findVerifiedDomain(sender.podId, sender.domain);
        if (!domain?.dkimPrivateKey) return undefined;
        return { domainName: domain.domain, keySelector: 'lm1', privateKey: decryptSecret(domain.dkimPrivateKey, encryptionKey!) };
      },
    });
    app.addHook('onClose', () => {
      transport.close?.();
    });
  }
  if (objectStorage)
    app.addHook('onClose', () => objectStorage.client.destroy());

  app.register(swagger, {
    openapi: {
      info: {
        title: 'LocalMail API',
        description: 'Local-first email inbox API for AI agents.',
        version: '0.1.0',
      },
      tags: [
        { name: 'Health' },
        { name: 'Inboxes' },
        { name: 'Threads' },
        { name: 'Messages' },
        { name: 'Webhooks' },
        { name: 'WebSockets' },
        { name: 'Search' },
        { name: 'Pods' },
        { name: 'API Keys' },
        { name: 'Domains' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
              'LocalMail API key using the lm_live_… or lm_admin_… prefix convention.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: createJsonSchemaTransformObject({
      schemas: {
        Inbox: inboxResponseSchema,
        Thread: threadSummarySchema,
        Message: messageResponseSchema,
        MessageSummary: messageSummarySchema,
        Pagination: paginationSchema,
        Webhook: webhookResponseSchema,
        WebhookDelivery: deliveryResponseSchema,
        Draft: draftResponseSchema,
        ErrorResponse: errorResponseSchema,
      },
    }),
  });
  app.register(swaggerUi, { routePrefix: '/docs' });

  const rateLimitRedis = ownedDatabase ? createRedisConnection(env.REDIS_URL) : null;
  if (rateLimitRedis) app.addHook('onClose', () => rateLimitRedis.disconnect());
  const rateLimiter = rateLimitRedis
    ? createRedisRateLimiter(
        rateLimitRedis,
        { rate: env.RATE_LIMIT_POD_RPS, burst: env.RATE_LIMIT_POD_BURST },
        { rate: env.RATE_LIMIT_RPS, burst: env.RATE_LIMIT_BURST },
      )
    : undefined;
  app.register(authPlugin, { store, rateLimiter, onRateLimited: (scope) => rateLimited.inc({ scope }) });
  app.register(idempotencyPlugin, { store });

  if (!encryptionKey) {
    throw new Error(
      'APP_ENCRYPTION_KEY is required for webhook routes (set env or CreateAppOptions.encryptionKey).',
    );
  }
  if (!webhookTestFire) {
    throw new Error(
      'Webhook test-fire publisher is required (durable publisher or CreateAppOptions.webhookTestFire).',
    );
  }

  const ownedWsSubscriber =
    options.wsSubscriber !== undefined
      ? options.wsSubscriber
      : ownedDatabase
        ? createRedisSubscriber(env.REDIS_URL)
        : null;
  if (ownedWsSubscriber && options.wsSubscriber === undefined) {
    app.addHook('onClose', () => {
      ownedWsSubscriber.disconnect();
    });
  }

  // §2.3 G1: every route is registered inside one child plugin so avvio boots
  // it *after* swagger (registered above) has installed its onRoute hook.
  // Registering routes directly on `app` before swagger resolves means none
  // of them are captured in the generated spec.
  app.register(async (instance) => {
    const typedInstance = instance.withTypeProvider<ZodTypeProvider>();

    typedInstance.get(
      '/healthz',
      {
        schema: {
          tags: ['Health'],
          operationId: 'getHealth',
          response: { 200: healthResponseSchema, ...errorResponses },
        },
      },
      () => ({
        status: 'ok' as const,
        service: 'localmail-api' as const,
        timestamp: new Date().toISOString(),
      }),
    );

    typedInstance.get(
      '/v1/me',
      {
        schema: {
          tags: ['Health'],
          operationId: 'getCurrentApiKey',
          security: [{ bearerAuth: [] }],
          response: { 200: meResponseSchema, ...errorResponses },
        },
      },
      (request) => ({
        pod_id: request.podId,
        api_key_id: request.apiKeyRow.id,
        scopes: request.apiKeyRow.scopes,
      }),
    );

    registerInboxRoutes(instance, { env, store });
    registerMessageRoutes(instance, {
      store,
      outbound,
      rawObjectReader,
      attachmentUrlSigner:
        options.attachmentUrlSigner ??
        createAttachmentUrlSigner(
          env.ATTACHMENT_SIGNING_KEY ?? env.ADMIN_API_KEY,
        ),
    });
    registerDraftRoutes(instance, { store, outbound });
    registerPodRoutes(instance, store);
    registerSearchRoutes(instance, store);
    registerDomainRoutes(instance, store, encryptionKey, env.MAIL_DOMAIN);
    registerWebhookRoutes(instance, {
      store,
      encryptionKey,
      testFire: webhookTestFire,
    });

    if (ownedWsSubscriber) {
      await registerWsRoutes(instance, {
        store,
        subscriber: ownedWsSubscriber,
      });
    }

    if (options.registerRoutes) await instance.register(options.registerRoutes);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorBody = {
      error: {
        code: 'not_found',
        message: 'The requested resource was not found.',
      },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const apiError =
      error instanceof ApiError
        ? error
        : (toValidationError(error) ??
          new ApiError('internal_error', 500, 'An unexpected error occurred.'));

    if (apiError.statusCode >= 500) app.log.error(error);
    return reply.code(apiError.statusCode).send(toErrorBody(apiError));
  });

  return app;
}
