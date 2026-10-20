/**
 * Application error model. Every failure that can reach a client is mapped to a
 * stable machine-readable `code` and an HTTP status. Internal details never
 * leak: `message` is always safe to show to the user.
 */
export type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'url_blocked'
  | 'url_fetch_failed'
  | 'url_unsupported_content'
  | 'extraction_failed'
  | 'provider_error'
  | 'provider_rate_limited'
  | 'internal_error';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Whether an ingestion job hitting this error should be retried. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { status?: number; details?: unknown; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.details = opts.details;
    this.retryable = opts.retryable ?? defaultRetryable(code);
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'validation_error':
      return 400;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'url_blocked':
    case 'url_unsupported_content':
    case 'extraction_failed':
      return 422;
    case 'url_fetch_failed':
      return 502;
    case 'provider_error':
      return 502;
    case 'provider_rate_limited':
      return 503;
    case 'internal_error':
    default:
      return 500;
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  return code === 'url_fetch_failed' || code === 'provider_error' || code === 'provider_rate_limited' || code === 'internal_error';
}

/** Normalises unknown thrown values into an AppError without leaking internals. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('internal_error', 'Unexpected internal error', { cause: err, details: { message } });
}

/** Body shape used for every error response. */
export interface ErrorResponseBody {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}
