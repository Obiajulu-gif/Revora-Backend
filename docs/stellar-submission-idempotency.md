# Stellar Submission Idempotency

## Overview

This document defines the production behavior for idempotent Stellar payment submission implemented in:
- `src/index.ts` (route integration and validation)
- `src/middleware/idempotency.ts` (idempotency engine)
- `src/routes/health.test.ts` (deterministic test coverage)

The endpoint is:
- `POST /api/v1/stellar/submit-payment`

## Contract

### Request headers

- `x-user-id` (required)
- `x-user-role` (required)
- `idempotency-key` (required)

### Request body

```json
{
  "destination": "G...56-char-stellar-public-key...",
  "amount": "10.5000000"
}
```

Validation rules:
- `destination` must be a Stellar public key (`G` prefix, 56 chars, base32 charset).
- `amount` must be a positive numeric string with up to 7 decimal places.

### Response behavior

- `201` on first successful submission.
- `201` with `Idempotency-Status: cached` for duplicate request with same key and same payload.
- `409` with `Idempotency-Status: inflight` while first request with same key is still processing.
- `409` with `Idempotency-Status: conflict` when same key is reused with a different payload.
- `400` for invalid payload or missing `idempotency-key`.
- `401` when authentication headers are missing.
- `503` for Stellar upstream/service failures (sanitized error body).

## Security assumptions and hardening

- Upstream Stellar/Horizon failures are classified and sanitized before returning to clients.
- Idempotency is bound to a deterministic request fingerprint:
  - authenticated user id
  - request body (stable serialized)
- Key reuse with a different payload is rejected (`409 conflict`), preventing replay key abuse.
- Only successful (`2xx`) responses are cached for idempotency replay to avoid poisoning cache with auth/validation errors.
- Validation is strict and deterministic to prevent malformed or ambiguous transaction requests.

## Operational notes

- Current default store is in-memory and process-local.
- For multi-instance deployments, replace with a shared store (Redis/Postgres) implementing `IdempotencyStore`.
- Choose key TTL based on business tolerance for replay windows.

## Test coverage

`src/routes/health.test.ts` includes deterministic tests for:
- auth boundary enforcement
- required `idempotency-key`
- invalid payload rejection
- same-key replay returns cached response
- same-key different payload returns conflict
- upstream failure classification and mapping behavior

`src/middleware/idempotency.test.ts` covers in-flight collision behavior (`Idempotency-Status: inflight`).
