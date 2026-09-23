import createFetchClient, { type Client, type Middleware } from 'openapi-fetch';

import { LocalMailConfigError, LocalMailError, toLocalMailError } from './errors.js';
import type { paths } from './generated/openapi.js';

export interface LocalMailOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
export const MAX_RETRIES = 2;

function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

function resolveBaseUrl(options: LocalMailOptions): string {
  return options.baseUrl ?? readEnv('LOCALMAIL_API_URL') ?? DEFAULT_BASE_URL;
}

function resolveApiKey(options: LocalMailOptions): string {
  const apiKey = options.apiKey ?? readEnv('LOCALMAIL_API_KEY');
  if (!apiKey) {
    throw new LocalMailConfigError(
      'No LocalMail API key configured. Pass { apiKey } or set LOCALMAIL_API_KEY. ' +
        'The SDK never runs in a silent anonymous mode.',
    );
  }
  return apiKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** openapi-fetch already parsed the JSON body into `error` for a non-2xx
 * response, so build the `LocalMailError` from it instead of re-reading the
 * (already-consumed) response stream. */
function errorFromParsedBody(response: Response, error: unknown): LocalMailError | null {
  const body = (error as { error?: Record<string, unknown> } | null)?.error;
  if (!body || typeof body.code !== 'string' || typeof body.message !== 'string') return null;
  return new LocalMailError({
    status: response.status,
    code: body.code,
    message: body.message,
    details: body.details as LocalMailError['details'],
    requestId: response.headers.get('x-request-id') ?? undefined,
  });
}

function backoffMs(attempt: number): number {
  const base = 100 * 2 ** attempt;
  return base + Math.random() * base * 0.25;
}

/**
 * §3.3: a fresh idempotency key generated per attempt gives no protection,
 * and silently reusing one is surprising, so only GETs and mutating calls
 * that carry a *caller-supplied* `idempotencyKey` are retried.
 */
export interface RequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface OpenApiResult<T> {
  data?: T;
  response: Response;
  error?: unknown;
}

/**
 * Retries network errors and 502/503/504 responses when `attemptable` is
 * true (a GET, or a mutation with a caller-supplied idempotency key), then
 * unwraps the openapi-fetch result into `T` or throws `LocalMailError`.
 */
export async function withRetry<T>(
  attemptable: boolean,
  run: () => Promise<OpenApiResult<T>>,
): Promise<T> {
  const maxAttempts = attemptable ? MAX_RETRIES + 1 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const { data, response, error } = await run();
      if (response.ok) return data as T;

      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw error instanceof LocalMailError
        ? error
        : errorFromParsedBody(response, error) ?? (await toLocalMailError(response));
    } catch (caught) {
      lastError = caught;
      const isNetworkError = !(caught instanceof LocalMailError);
      if (isNetworkError && attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw caught;
    }
  }
  throw lastError;
}

export class LocalMailTransport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly client: Client<paths>;
  readonly customFetch?: typeof fetch;
  readonly timeoutMs: number;

  constructor(options: LocalMailOptions = {}) {
    this.baseUrl = resolveBaseUrl(options);
    this.apiKey = resolveApiKey(options);
    this.customFetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.client = createFetchClient<paths>({
      baseUrl: this.baseUrl,
      fetch: this.customFetch,
    });
    const authMiddleware: Middleware = {
      onRequest: ({ request }) => {
        request.headers.set('authorization', `Bearer ${this.apiKey}`);
        return request;
      },
    };
    this.client.use(authMiddleware);
  }

  /** Raw fetch, used by hand-written endpoints (multipart, raw bytes) that
   * aren't well described by the generated OpenAPI types (§2.3 G8). */
  async rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(
      path.replace(/^\//, ''),
      this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`,
    );
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.apiKey}`);
    const doFetch = this.customFetch ?? fetch;
    return doFetch(url, { ...init, headers });
  }

  headersFor(options: RequestOptions): Record<string, string> {
    return options.idempotencyKey
      ? { 'idempotency-key': options.idempotencyKey }
      : {};
  }
}
