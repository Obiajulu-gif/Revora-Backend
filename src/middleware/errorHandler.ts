import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode, ErrorResponse } from '../lib/errors';

/**
 * Global Express error-handling middleware.
 *
 * Mount after all routes:
 * ```ts
 * app.use(errorHandler);
 * ```
 *
 * Behaviour:
 * - `AppError` instances → correct HTTP status + `ErrorResponse` body via `toResponse()`
 * - Any other error → HTTP 500 + opaque `{ code: INTERNAL_ERROR, message: ... }`
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  // Express requires the fourth argument for the function to be recognised
  // as an error handler, even when it is unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toResponse());
    return;
  }

  // Unknown / unexpected error — log and return an opaque 500.
  // eslint-disable-next-line no-console
  console.error('[errorHandler] Unhandled error:', err);

  const body: ErrorResponse = {
    code: ErrorCode.INTERNAL_ERROR,
    message: 'Internal server error',
  };

  res.status(500).json(body);
};
