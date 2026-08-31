import type { ErrorCode } from '@scansign/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Any failure we deliberately surface to a client, with a stable code. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode | string;
  readonly details?: unknown;

  constructor(
    status: ContentfulStatusCode,
    message: string,
    code: ErrorCode | string = 'INTERNAL_ERROR',
    details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HttpError(400, message, code, details);

export const unauthorized = (message = 'Authentification requise.') =>
  new HttpError(401, message, 'UNAUTHORIZED');

export const forbidden = (message = 'Accès refusé.') => new HttpError(403, message, 'FORBIDDEN');

export const notFound = (message = 'Ressource introuvable.') =>
  new HttpError(404, message, 'NOT_FOUND');

export const payloadTooLarge = (message: string) =>
  new HttpError(413, message, 'FILE_TOO_LARGE');

export const unsupportedMedia = (message: string) =>
  new HttpError(415, message, 'UNSUPPORTED_MIME');
