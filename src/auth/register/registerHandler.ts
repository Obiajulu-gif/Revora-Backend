import { NextFunction, Request, RequestHandler, Response } from 'express';
import { UniqueConstraintError } from '../../lib/errors';
import { DuplicateEmailError, RegisterService } from './registerService';
import { RegisterRequestBody } from './types';

/** Minimal RFC-5322-ish email pattern – same rigour used across the auth module. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12; // Must align with passwordStrength validator

/**
 * Express handler factory for `POST /api/auth/investor/register`.
 *
 * Validates the request body, delegates to `RegisterService`, and returns:
 *   201  { user: { id, email, role } }   – successful registration
 *   400  { error, message }              – missing or invalid email or password
 *   409  { error, message }              – duplicate email: thrown as
 *                                          `DuplicateEmailError` (application-layer
 *                                          pre-query check) or `UniqueConstraintError`
 *                                          (database-layer 23505 violation); both
 *                                          paths return the same body so callers
 *                                          cannot distinguish them
 *   500  (delegated to Express error handler) – unexpected server error
 */
export const createRegisterHandler = (
  registerService: RegisterService,
): RequestHandler => {
  return async (
    req: Request<unknown, unknown, RegisterRequestBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { email, password } = req.body ?? {};

      // ── Presence ────────────────────────────────────────────────────────
      if (!email || !password) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Both "email" and "password" are required.',
        });
        return;
      }

      // ── Type guards ──────────────────────────────────────────────────────
      if (typeof email !== 'string' || typeof password !== 'string') {
        res.status(400).json({
          error: 'Bad Request',
          message: '"email" and "password" must be strings.',
        });
        return;
      }

      // ── Email format ─────────────────────────────────────────────────────
      if (!EMAIL_RE.test(email)) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid email address.',
        });
        return;
      }

      // ── Password length ──────────────────────────────────────────────────
      if (password.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({
          error: 'Bad Request',
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
        return;
      }

      const user = await registerService.register(email, password);

      res.status(201).json({
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        res.status(409).json({ error: 'Conflict', message: 'Email already registered' });
        return;
      }
      if (error instanceof UniqueConstraintError) {
        res.status(409).json({ error: 'Conflict', message: 'Email already registered' });
        return;
      }
      next(error);
    }
  };
};
