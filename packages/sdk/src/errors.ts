export interface LocalMailErrorDetail {
  path: string;
  message: string;
}

/** Non-2xx envelope shape, per apps/api/src/errors.ts `ErrorBody`. */
export class LocalMailError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: LocalMailErrorDetail[];
  readonly requestId?: string;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: LocalMailErrorDetail[];
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'LocalMailError';
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
  }
}

export class LocalMailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalMailConfigError';
  }
}

export class LocalMailTimeoutError extends Error {
  readonly inboxId: string;
  readonly since: Date;

  constructor(inboxId: string, since: Date) {
    super(`Timed out waiting for a matching email in inbox ${inboxId}.`);
    this.name = 'LocalMailTimeoutError';
    this.inboxId = inboxId;
    this.since = since;
  }
}

export async function toLocalMailError(response: Response): Promise<LocalMailError> {
  const requestId = response.headers.get('x-request-id') ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new LocalMailError({
      status: response.status,
      code: 'http_error',
      message: `Request failed with status ${response.status}.`,
      requestId,
    });
  }
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
    return new LocalMailError({
      status: response.status,
      code: 'http_error',
      message: `Request failed with status ${response.status}.`,
      requestId,
    });
  }
  return new LocalMailError({
    status: response.status,
    code: error.code,
    message: error.message,
    details: error.details as LocalMailErrorDetail[] | undefined,
    requestId,
  });
}
