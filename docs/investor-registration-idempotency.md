# Investor Registration Idempotency

## Overview

The `POST /api/auth/investor/register` endpoint is protected by an idempotency layer that prevents duplicate account creation on client retries (e.g. network timeouts, mobile reconnects, double-taps).

Clients supply an opaque `Idempotency-Key` header on the first request. Subsequent requests with the same key within the TTL window receive the cached response instead of executing the registration logic again.

---

## Request / Response Contract

### Request

```
POST /api/auth/investor/register
Content-Type: application/json
Idempotency-Key: <opaque-string>   # optional; required for idempotent retries

{
  "email": "investor@example.com",
  "password": "J7!kP2@mV5#nR"
}
```

### Success response (first call or uncached call)

```
HTTP/1.1 201 Created
Content-Type: application/json

{
  "user": {
    "id": "uuid",
    "email": "investor@example.com",
    "role": "investor"
  }
}
```

No `Idempotency-Status` header is present on a first-call response.

### Cached replay

When the same `Idempotency-Key` is reused within the TTL:

```
HTTP/1.1 201 Created
Content-Type: application/json
Idempotency-Status: cached

{ ...identical body as first call... }
```

### In-flight conflict

If a second request with the same key arrives while the first is still processing:

```
HTTP/1.1 409 Conflict
Idempotency-Status: inflight

{
  "error": "Request with this idempotency key is already in progress."
}
```

---

## Behavior Specification

| Scenario | Behaviour |
|---|---|
| No `Idempotency-Key` header | Request passes through normally; no caching |
| First request with key | Executes handler; response cached if status < 500 |
| Repeat request within TTL | Cached response replayed; handler not called |
| Repeat during first request | 409 returned; handler not called |
| Server error (5xx) on first call | Response not cached; next retry retriggers the handler |
| Key reused with different body | Cached response replayed; body differences ignored |
| TTL expired | Cache entry evicted; next request treated as new |

### What is cached

Responses with HTTP status **< 500** are cached (201, 400, 409, etc.).
This means:

- A successful 201 is replayed as-is on retry — the user is not re-created.
- A 400 validation error is replayed — the client must use a **new key** to retry with corrected data.
- A 409 duplicate-email response is replayed — the client cannot probe email existence by re-submitting with the same key.
- A 500 is **never cached** — transient infrastructure failures are always retryable.

---

## Security Assumptions

### Idempotency key confidentiality

Keys are caller-supplied opaque strings.  No personally-identifiable information (PII) should be embedded in them. Prefer UUID v4 values (e.g. `crypto.randomUUID()` on the client).

### Replay attack surface

The store maps keys to responses, not identities.  An attacker who knows a victim's idempotency key (e.g. by intercepting HTTPS — which is prevented by TLS) would only observe the same response that the legitimate client already received.  No additional privilege is conferred by replaying a cached response.

### Duplicate-email probing

The 409 duplicate-email response is cached just like a 201.  A client that registers `alice@example.com` and receives a 409 cannot re-submit with the same key to confirm the conflict — they will only receive the cached 409.  Using a new key against an already-registered email will produce a fresh 409, but this is unavoidable for any registration endpoint.

### Single-process store

`InMemoryIdempotencyStore` is per-process.  In a multi-instance deployment (load-balanced or horizontally scaled):

- Two requests with the same key can reach different instances.
- Each instance has its own cache → duplicate execution is possible.
- **Replace the store with a Redis-backed implementation** before deploying behind a load balancer.  The `IdempotencyStore` interface in [`src/middleware/idempotency.ts`](../src/middleware/idempotency.ts) is the only contract that needs to be satisfied.

### TTL and memory growth

The store uses a 24-hour TTL (`24 * 60 * 60 * 1000` ms).  Each cached entry is small (JSON body + metadata).  At 10 registrations/second sustained for 24 hours, the store would hold ~864 000 entries — acceptable for most deployments.  Monitor heap usage in production and tune `ttlMs` accordingly.

### Rate limiting

Idempotency does **not** replace rate limiting.  The endpoint should be fronted by a separate rate limiter (e.g. `express-rate-limit`) to prevent key-churn attacks (submitting many unique keys to exhaust memory).

---

## Abuse / Failure Paths

| Path | Mitigation |
|---|---|
| Client submits many unique keys to exhaust memory | Rate limit the endpoint at the load-balancer or via middleware |
| Client re-uses key after TTL to force re-registration | Application duplicate-email check (DB read) prevents re-creation |
| Concurrent duplicate key in a multi-instance deployment | Replace `InMemoryIdempotencyStore` with a distributed store (Redis with `SET NX`) |
| Network failure after 5xx | Response not cached; retry executes handler again — safe because user creation is guarded by a unique constraint |
| Client sends wrong body on retry (same key) | Cached response from first call is returned; corrected body is ignored — client must use new key |

---

## Implementation Notes

### Wiring in `createApp()`

```typescript
// src/index.ts  (inside createApp)
const registrationIdempotencyStore = new InMemoryIdempotencyStore({
  ttlMs: 24 * 60 * 60 * 1000,          // 24-hour TTL
});

// Scope idempotency middleware to this path only
app.use(
  '/api/auth/investor/register',
  createIdempotencyMiddleware({
    store: registrationIdempotencyStore,
    methods: ['POST'],
  }),
);

// Mount the register router (handles full /api/auth/investor/register path)
const registerUserRepository = new UserRepository(pool);
app.use(
  createRegisterRouter({
    userRepository: {
      findByEmail: (email) => registerUserRepository.findByEmail(email),
      createUser:  (input) => registerUserRepository.createUser(input),
    },
  }),
);
```

The idempotency middleware is **not** applied globally — only to the registration path.  This prevents unintended caching of other POST endpoints that may not be idempotency-safe.

### Email normalisation

`RegisterService` lowercases and trims the email before the duplicate check and before persistence.  The normalised email is stored and returned in all responses (including cached replays), so `Eve@Example.COM` and `eve@example.com` are treated as the same identity.

### Password hashing

SHA-256 is used (Node.js built-in `crypto` — no external dependencies).  The hash is stored in the database and **never** appears in any response body.  Tests verify this contract explicitly.

---

## Test Coverage

Tests live in [`src/routes/health.test.ts`](../src/routes/health.test.ts) under `describe('Investor Registration Idempotency')`.

| Test | What it verifies |
|---|---|
| No body → 400 | Input validation |
| Missing email → 400 | Input validation |
| Missing password → 400 | Input validation |
| Invalid email format → 400 | Input validation |
| Short password → 400 | Password strength policy |
| Success without key → 201 | Happy path (no idempotency) |
| Same key replayed → cached 201 | Core idempotency replay |
| Different keys, same email → 201 then 409 | Duplicate-email detection |
| Same key after 409 → cached 409 | 409 responses are cached |
| Bad email with key → cached 400 | 400 responses are cached |
| No auth header required → not 401 | Public endpoint |
| Mixed-case email normalised | Email normalisation + replay consistency |
| 201 body shape | Response contract (`{ user: { id, email, role } }`) |
| No credential material in 201 | Security: password/hash not leaked |
