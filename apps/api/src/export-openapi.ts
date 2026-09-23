/**
 * §2.4 spec-as-artifact: builds the app entirely in memory (no Postgres,
 * Redis, or MinIO — a stub store/outbound/publisher, wsSubscriber: null) and
 * writes its OpenAPI document to packages/sdk/openapi.json. Both that file
 * and the SDK's generated types built from it are committed, so the SDK
 * builds without a running API.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnv } from '@localmail/config';
import { noopMessageEventPublisher } from '@localmail/core';

import { createApp } from './app.js';
import type { ApiStore } from './store.js';
import type { OutboundMessageService } from './outbound.js';
import type { WebhookTestFire } from './webhooks.js';

export function buildOpenApiDocument(): Promise<Record<string, unknown>> {
  const notImplemented = () =>
    Promise.reject(new Error('export-openapi: store is not backed by a real database'));
  const store = new Proxy({} as ApiStore, {
    get: () => notImplemented,
  });
  const outbound: OutboundMessageService = { send: notImplemented };
  const webhookTestFire: WebhookTestFire = { enqueueTestFire: notImplemented };

  const app = createApp(
    parseEnv({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    }),
    {
      logger: false,
      store,
      outbound,
      rawObjectReader: { getStream: notImplemented },
      eventPublisher: noopMessageEventPublisher,
      webhookTestFire,
      wsSubscriber: null,
    },
  );

  return Promise.resolve(app.ready()).then(
    async () => {
      const document = app.swagger() as unknown as Record<string, unknown>;
      await app.close();
      return document;
    },
    async (error: unknown) => {
      await app.close();
      throw error;
    },
  );
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

async function main(): Promise<void> {
  const document = sortKeysDeep(await buildOpenApiDocument());
  const outFile = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../packages/sdk/openapi.json',
  );
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outFile}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
