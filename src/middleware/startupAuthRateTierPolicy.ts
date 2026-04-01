import { Request, RequestHandler } from 'express';
import { createRateLimitMiddleware, InMemoryRateLimitStore } from './rateLimit';

export type StartupAuthRateTier = 'standard' | 'trusted' | 'internal';

interface StartupAuthRateTierPolicy {
  limit: number;
  windowMs: number;
  message: string;
}

export const STARTUP_AUTH_RATE_TIER_HEADER = 'x-revora-rate-tier';
export const STARTUP_AUTH_TIER_SECRET_HEADER = 'x-revora-tier-secret';

export const STARTUP_AUTH_RATE_TIER_POLICIES: Record<
  StartupAuthRateTier,
  StartupAuthRateTierPolicy
> = {
  standard: {
    limit: 5,
    windowMs: 15 * 60 * 1000,
    message:
      'Too many registration attempts, please try again after 15 minutes.',
  },
  trusted: {
    limit: 10,
    windowMs: 15 * 60 * 1000,
    message:
      'Too many trusted-tier registration attempts, please try again after 15 minutes.',
  },
  internal: {
    limit: 25,
    windowMs: 15 * 60 * 1000,
    message:
      'Too many internal registration attempts, please try again after 15 minutes.',
  },
};

interface StartupAuthTierLimiterOptions {
  store?: InMemoryRateLimitStore;
  tierSecretEnvName?: string;
}

interface StartupAuthTierLimiter {
  middleware: RequestHandler;
  resolveTier: (req: Request) => StartupAuthRateTier;
  reset: () => void;
}

/**
 * Builds startup-auth tier resolution and enforcement middleware.
 * Security assumption: privileged tiers are honored only with a valid shared secret.
 */
export function createStartupAuthTierLimiter(
  options: StartupAuthTierLimiterOptions = {},
): StartupAuthTierLimiter {
  const store = options.store ?? new InMemoryRateLimitStore();
  const tierSecretEnvName = options.tierSecretEnvName ?? 'STARTUP_AUTH_TIER_SECRET';

  const resolveTier = (req: Request): StartupAuthRateTier => {
    const requestedTier = req
      .header(STARTUP_AUTH_RATE_TIER_HEADER)
      ?.trim()
      .toLowerCase();

    if (requestedTier !== 'trusted' && requestedTier !== 'internal') {
      return 'standard';
    }

    const configuredSecret = process.env[tierSecretEnvName]?.trim();
    const providedSecret = req
      .header(STARTUP_AUTH_TIER_SECRET_HEADER)
      ?.trim();
    if (!configuredSecret || !providedSecret || configuredSecret !== providedSecret) {
      return 'standard';
    }

    return requestedTier;
  };

  const tierLimiters: Record<StartupAuthRateTier, RequestHandler> = {
    standard: createRateLimitMiddleware({
      ...STARTUP_AUTH_RATE_TIER_POLICIES.standard,
      keyPrefix: 'startup-auth:standard',
      store,
    }),
    trusted: createRateLimitMiddleware({
      ...STARTUP_AUTH_RATE_TIER_POLICIES.trusted,
      keyPrefix: 'startup-auth:trusted',
      store,
    }),
    internal: createRateLimitMiddleware({
      ...STARTUP_AUTH_RATE_TIER_POLICIES.internal,
      keyPrefix: 'startup-auth:internal',
      store,
    }),
  };

  const middleware: RequestHandler = (req, res, next): void => {
    const tier = resolveTier(req);
    res.setHeader('X-RateLimit-Tier', tier);
    tierLimiters[tier](req, res, next);
  };

  const reset = (): void => {
    store.clear?.();
  };

  return { middleware, resolveTier, reset };
}
