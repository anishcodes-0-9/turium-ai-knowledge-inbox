import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, toAppError, type ErrorResponseBody } from '../errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('not_found', `Route ${req.method} ${req.path} does not exist`));
};

/**
 * Central error handler: every error becomes `{ error: { code, message, details?, requestId } }`.
 * Unexpected errors are logged with their stack but the client only sees a generic message.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = typeof req.id === 'string' ? req.id : undefined;
  // Body-parser errors (malformed JSON, payload too large) arrive as plain errors with a status/type.
  const bodyErr = err as { type?: string; status?: number };
  let appErr: AppError;
  if (bodyErr?.type === 'entity.parse.failed') appErr = new AppError('validation_error', 'Request body is not valid JSON');
  else if (bodyErr?.type === 'entity.too.large') appErr = new AppError('validation_error', 'Request body is too large', { status: 413 });
  else appErr = toAppError(err);

  const logger = req.log ?? undefined;
  const logFields = { code: appErr.code, status: appErr.status, err: appErr.status >= 500 ? appErr : undefined, cause: appErr.cause instanceof Error ? appErr.cause.message : undefined };
  if (appErr.status >= 500) logger?.error(logFields, appErr.message);
  else logger?.warn(logFields, appErr.message);

  const body: ErrorResponseBody = {
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.code === 'validation_error' && appErr.details ? { details: appErr.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
  res.status(appErr.status).json(body);
};
