import { hashPassword, comparePassword as verifyPassword } from '../../utils/password';
import { validatePasswordStrength } from '../../lib/passwordStrength';
import { Errors } from '../../lib/errors';
import { globalLogger } from '../../lib/logger';

// ── Port interface ────────────────────────────────────────────────────────────
// Keeps the service decoupled from pg and the concrete UserRepository.
export interface ChangePasswordUserRepo {
  findUserById(id: string): Promise<{ id: string; password_hash: string } | null>;
  updatePasswordHash(userId: string, newHash: string): Promise<void>;
}

// ── Input / Output types ──────────────────────────────────────────────────────
export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResult {
  ok: true;
}

// ── Service ───────────────────────────────────────────────────────────────────
export class ChangePasswordService {
  constructor(private readonly userRepo: ChangePasswordUserRepo) {}

  async execute(input: ChangePasswordInput): Promise<ChangePasswordResult> {
    const { userId, currentPassword, newPassword } = input;

    // Validate inputs first (cheap, no DB hit)
    if (!currentPassword) {
      throw Errors.badRequest('currentPassword is required.');
    }

    // Validate new password strength
    const strength = validatePasswordStrength(newPassword);
    if (!strength.isValid) {
      globalLogger.warn('Change password failed: weak new password', {
        userId,
        errorCodes: strength.errors.map((e) => e.code),
      });
      throw Errors.validationError('New password does not meet strength requirements', {
        errors: strength.errors,
      });
    }

    // Load user
    const user = await this.userRepo.findUserById(userId);
    if (!user) {
      throw Errors.notFound('User not found.');
    }

    // Verify current password using scrypt timing-safe compare (src/lib/hash.ts)
    const isMatch = await verifyPassword(currentPassword, user.password_hash);
    if (!isMatch) {
      globalLogger.warn('Change password failed: incorrect current password', { userId });
      throw Errors.badRequest('Current password is incorrect.');
    }

    // Hash and persist
    const newHash = await hashPassword(newPassword);
    await this.userRepo.updatePasswordHash(userId, newHash);

    return { ok: true };
  }
}