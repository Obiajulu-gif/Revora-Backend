# Rate Limiter Tier Policies

## Overview
This document describes the production-focused tier policy rate limiter implemented for startup authentication routes.

Implementation targets:
- `src/index.ts`
- `src/middleware/rateLimit.ts`
- `src/middleware/startupAuthRateTierPolicy.ts`
- `src/routes/health.test.ts`
- `src/middleware/startupAuthRateTierPolicy.test.ts`

The capability enforces deterministic per-tier limits for `POST /api/v1/startup/register`.

## Tier Policy Matrix
| Tier | Limit | Window | Eligibility |
| --- | --- | --- | --- |
| `standard` | 5 requests | 15 minutes | Default for all requests |
| `trusted` | 10 requests | 15 minutes | Requires valid tier secret |
| `internal` | 25 requests | 15 minutes | Requires valid tier secret |

All tiers return standard rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) and add `X-RateLimit-Tier` for observability.

## Security Assumptions
1. The `x-revora-rate-tier` header is treated as untrusted client input.
2. Elevated tiers (`trusted`, `internal`) are accepted only when `x-revora-tier-secret` matches `STARTUP_AUTH_TIER_SECRET`.
3. If the secret is missing or invalid, requests are downgraded to the `standard` tier.
4. The app is deployed behind a trusted proxy (`app.set('trust proxy', 1)`) so IP-based keys are stable for abuse controls.
5. The in-memory limiter is process-local; distributed production environments should replace it with a shared store.

## Abuse and Failure Paths
- Header spoofing (`x-revora-rate-tier: trusted`) without secret authorization: downgraded to `standard`.
- Invalid/unknown tier names: downgraded to `standard`.
- Counter isolation: tier-specific key prefixes prevent one tier's counters from colliding with another tier.
- Health endpoint isolation: startup auth limits do not throttle `/health`.
- Rate limiter store failure behavior: existing middleware behavior is deterministic in-process; external shared-store failures should be handled with explicit fallback strategy during Redis migration.

## Tests
Comprehensive integration coverage was added in `src/routes/health.test.ts` and direct policy tests in `src/middleware/startupAuthRateTierPolicy.test.ts`:
1. Standard tier blocks the 6th request.
2. Trusted tier allows 10 requests and blocks the 11th when secret authorization is valid.
3. Spoofed trusted tier without secret falls back to standard limits.
4. Internal tier allows 25 requests and blocks the 26th.
5. `/health` remains available while startup auth is rate limited.

Validation commands:
- `npm test -- --runInBand`
- `npm run test:coverage -- --runInBand` (repository-wide baseline report)
- `npm run test:coverage:backend-011` (feature-scope 95% gate)

Latest feature-scope coverage result:
- Statements: `100%`
- Lines: `100%`
- Functions: `100%`
