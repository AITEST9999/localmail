import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';

export type ApiErrorCode =
  | 'validation_error'
  | 'missing_authorization'
  | 'invalid_api_key'
  | 'insufficient_scope'
  | 'not_found'
  | 'idempotency_key_reused'
  | 'address_taken'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error';

export interface ErrorDetail {
  path: string;
  message: string;
}

export interface ErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ErrorDetail[];
  };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: ErrorDetail[];

  constructor(
    code: ApiErrorCode,
    statusCode: number,
    message: string,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function toValidationError(error: unknown): ApiError | null {
  if (!hasZodFastifySchemaValidationErrors(error)) return null;

  return new ApiError(
    'validation_error',
    400,
    'Request validation failed.',
    error.validation.map(({ params }) => ({
      path: params.issue.path.join('.'),
      message: params.issue.message,
    })),
  );
}

export function toErrorBody(error: ApiError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});

/**
 * Shared 4xx response schemas (§2.3 G6). Merge into a route's `response` map
 * so `ErrorResponse` shows up in the generated OpenAPI spec instead of only
 * being described for 2xx bodies.
 */
export const errorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  413: errorResponseSchema,
  429: errorResponseSchema,
};
