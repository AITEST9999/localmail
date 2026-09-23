import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { ApiError } from './errors.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_URL_TTL_SECONDS = 5 * 60;

export const PREVIEW_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
]);

export interface UploadedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  sha256: string;
}

export interface AttachmentSignaturePayload {
  podId: string;
  inboxId: string;
  messageId: string;
  attachmentId: string;
  expires: number;
}

export interface AttachmentUrlSigner {
  expiresAfter(seconds: number): number;
  sign(payload: AttachmentSignaturePayload): string;
  verify(
    payload: AttachmentSignaturePayload,
    signature: string,
  ): 'valid' | 'expired' | 'invalid';
}

declare module 'fastify' {
  interface FastifyRequest {
    outboundAttachments?: UploadedAttachment[];
    idempotencyBody?: unknown;
  }
}

export function createAttachmentUrlSigner(
  secret: string,
  now: () => Date = () => new Date(),
): AttachmentUrlSigner {
  const sign = (payload: AttachmentSignaturePayload) =>
    createHmac('sha256', secret).update(signatureInput(payload)).digest('hex');

  return {
    expiresAfter(seconds) {
      return Math.floor(now().getTime() / 1000) + seconds;
    },
    sign,
    verify(payload, signature) {
      if (!/^[a-f0-9]{64}$/.test(signature)) return 'invalid';
      const expected = Buffer.from(sign(payload), 'hex');
      const supplied = Buffer.from(signature, 'hex');
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      ) {
        return 'invalid';
      }
      return Math.floor(now().getTime() / 1000) >= payload.expires
        ? 'expired'
        : 'valid';
    },
  };
}

export async function parseMultipartMessage(
  request: FastifyRequest,
): Promise<void> {
  request.outboundAttachments = [];
  if (!request.isMultipart()) return;

  let payload: unknown;
  let payloadSeen = false;
  const attachments: UploadedAttachment[] = [];

  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname !== 'payload' || payloadSeen) {
        throw validationError(
          part.fieldname,
          'multipart requests require exactly one payload JSON field',
        );
      }
      payloadSeen = true;
      try {
        payload =
          typeof part.value === 'string'
            ? (JSON.parse(part.value) as unknown)
            : part.value;
      } catch {
        throw validationError('payload', 'must contain valid JSON');
      }
      continue;
    }

    if (part.fieldname !== 'attachments') {
      part.file.resume();
      throw validationError(
        part.fieldname,
        'file parts must use the attachments field name',
      );
    }
    const read = await readAttachmentStream(part.file, MAX_ATTACHMENT_BYTES);
    if (part.file.truncated) throw attachmentTooLargeError();
    attachments.push({
      filename: part.filename || 'attachment.bin',
      contentType: part.mimetype || 'application/octet-stream',
      ...read,
    });
  }

  if (!payloadSeen) {
    throw validationError(
      'payload',
      'multipart requests require a payload JSON field',
    );
  }

  request.body = payload;
  request.outboundAttachments = attachments;
  request.idempotencyBody = {
    body: payload,
    attachments: attachments.map(({ filename, contentType, content, sha256 }) => ({
      filename,
      content_type: contentType,
      size: content.byteLength,
      sha256,
    })),
  };
}

export async function readAttachmentStream(
  stream: AsyncIterable<Uint8Array | string>,
  maximumBytes = MAX_ATTACHMENT_BYTES,
): Promise<{ content: Buffer; sha256: string }> {
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  let size = 0;

  for await (const value of stream) {
    const chunk = Buffer.from(value);
    size += chunk.byteLength;
    if (size > maximumBytes) throw attachmentTooLargeError();
    chunks.push(chunk);
    hash.update(chunk);
  }

  return { content: Buffer.concat(chunks, size), sha256: hash.digest('hex') };
}

export function isPreviewableContentType(contentType: string): boolean {
  return PREVIEW_CONTENT_TYPES.has(contentType.toLowerCase().split(';', 1)[0] ?? '');
}

export function safeDownloadFilename(filename: string): string {
  const cleaned = filename.replaceAll(/[\r\n"\\]/g, '_').trim();
  return (cleaned || 'attachment.bin').slice(0, 180);
}

export function attachmentTooLargeError(): ApiError {
  return new ApiError(
    'payload_too_large',
    413,
    'Attachment exceeds the 25 MB size limit.',
  );
}

function signatureInput(payload: AttachmentSignaturePayload): string {
  return [
    payload.podId,
    payload.inboxId,
    payload.messageId,
    payload.attachmentId,
    String(payload.expires),
  ].join('\n');
}

function validationError(path: string, message: string): ApiError {
  return new ApiError('validation_error', 400, 'Request validation failed.', [
    { path, message },
  ]);
}
