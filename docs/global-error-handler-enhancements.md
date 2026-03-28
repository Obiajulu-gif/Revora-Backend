# Global Error Handler Enhancements

## Overview

This document describes the global error handler implemented in
`Revora-Backend`. It acts as a safety net for the entire application —
catching any unhandled error from any route and returning a clean,
safe, consistent JSON response without leaking internal details.

---

## How It Works

1. A route throws an error or calls `next(error)`
2. Express skips all normal middleware and routes
3. The global error handler catches it
4. If it is an `AppError` — the correct status code and message are returned
5. If it is an unknown error — a generic 500 is returned
6. The `requestId` is always included in the response if available

---

## Implementation

**File:** `src/middleware/errorHandler.ts`

### `errorHandler(err, req, res, next): void`
A standard Express 4-argument error handling middleware. Must be
registered AFTER all routes in `src/index.ts`.

Behaviour:
- `AppError` instances → serialised via `AppError.toResponse()` with
  the correct HTTP status code
- Unknown errors → logged and returned as a generic 500
- `requestId` from `req.requestId` is always forwarded in the response
  body for traceability
- Stack traces are never leaked to the client

**File:** `src/lib/errors.ts`

### `AppError`
Structured application error class. Carries a `code`, `statusCode`,
`message` and optional `details`. Use `Errors.*` factories for common
cases.

### `Errors` convenience factories

| Factory | Status | Code |
|---------|--------|------|
| `Errors.validationError()` | 400 | VALIDATION_ERROR |
| `Errors.badRequest()` | 400 | BAD_REQUEST |
| `Errors.unauthorized()` | 401 | UNAUTHORIZED |
| `Errors.forbidden()` | 403 | FORBIDDEN |
| `Errors.notFound()` | 404 | NOT_FOUND |
| `Errors.conflict()` | 409 | CONFLICT |
| `Errors.internal()` | 500 | INTERNAL_ERROR |

---

## Security Assumptions

- Stack traces and internal error details are never sent to the client
- Unknown errors always return a generic 500 — no internal message leakage
- `AppError` messages are developer-controlled and safe to expose
- The `requestId` is included for tracing but carries no sensitive data
- The error handler is registered after all routes — it cannot be
  bypassed by any route

---

## Abuse and Failure Paths

| Scenario | Behaviour |
|----------|-----------|
| Unauthenticated request | Returns `401 Unauthorized` |
| Unknown route | Returns `404 Not Found` |
| Invalid status transition | Returns `400` with error message |
| Invalid investment | Returns `400` with error message |
| Unexpected server error | Returns `500 Internal server error` |
| Error without requestId | Response body omits requestId field |
| Error with requestId | requestId included in response body |

---

## Test Coverage

**File:** `src/routes/health.test.ts`

| Test | What it verifies |
|------|-----------------|
| returns 500 for an unhandled error | Unknown routes return 404 |
| returns correct error shape for AppError | Error body has error field |
| returns 401 when auth is missing | Protected routes enforce auth |
| includes requestId in error response | requestId forwarded on errors |
| returns 404 for unknown routes | Unknown routes handled cleanly |
| returns 400 for invalid status transition | Transition errors caught |
| returns 400 when investing in non-published offering | Investment errors caught |

---

## Example Usage
```typescript
import { Errors } from '../lib/errors';

// Throw a structured error from any route:
if (!offering) {
  throw Errors.notFound('Offering not found');
}

// Or pass to next():
if (!user) {
  return next(Errors.unauthorized());
}
```

---

## Related Files

- `src/middleware/errorHandler.ts` — error handler middleware
- `src/lib/errors.ts` — AppError class and Errors factories
- `src/index.ts` — where errorHandler is registered after all routes
- `src/routes/health.test.ts` — integration tests
