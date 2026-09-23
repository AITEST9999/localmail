import { TypeSafeClient, type Fetch } from '@typesafe-ai/sdk';

import { JEV_TIMEOUT_MS } from './thresholds.js';

const DEFAULT_USER_AGENT = 'localmail-jev/1.0';

/** Wrap fetch so Cloudflare doesn't see a bare runtime UA (Hermes Jev note). */
export function createJevFetch(userAgent = DEFAULT_USER_AGENT): Fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', userAgent);
    return globalThis.fetch(input, { ...init, headers });
  };
}

export function createTypeSafeClient(options: {
  apiKey: string;
  timeoutMs?: number;
  fetch?: Fetch;
}): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: options.apiKey,
    timeout: options.timeoutMs ?? JEV_TIMEOUT_MS,
    fetch: options.fetch ?? createJevFetch(),
    // Prefer fast fail → rules path over multi-second retry storms.
    retry: { maxRetries: 0 },
    defaultHeaders: {
      'User-Agent': DEFAULT_USER_AGENT,
    },
  });
}
