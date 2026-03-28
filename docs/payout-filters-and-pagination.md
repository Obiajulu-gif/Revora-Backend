# Payout Filters and Pagination

## Overview

This document describes the payout listing endpoint enhancements for the Revora Backend. The feature adds production-grade filtering, sorting, and pagination controls to `GET /api/investments/payouts`, enabling investors to efficiently query their payout history.

## Implementation Details

### Query Parameters

| Parameter   | Type   | Default      | Description                                          |
|-------------|--------|--------------|------------------------------------------------------|
| `status`    | string | —            | Filter by payout status: `pending`, `processed`, `failed` |
| `minAmount` | string | —            | Filter payouts with amount ≥ value                   |
| `maxAmount` | string | —            | Filter payouts with amount ≤ value                   |
| `from`      | string | —            | Filter payouts created on or after this ISO-8601 date |
| `to`        | string | —            | Filter payouts created on or before this ISO-8601 date |
| `sortBy`    | string | `created_at` | Sort column: `created_at`, `amount`, `status`        |
| `sortOrder` | string | `desc`       | Sort direction: `asc`, `desc`                        |
| `limit`     | number | `20`         | Page size (max 100)                                  |
| `offset`    | number | `0`          | Number of records to skip                            |

### Response Shape

```json
{
  "payouts": [ /* array of Payout objects */ ],
  "total": 42,
  "limit": 20,
  "offset": 0,
  "hasMore": true
}
```

### Key Files

| File | Purpose |
|------|---------|
| `src/routes/payouts.ts` | Route handler with filtering, sorting, pagination, and validation |
| `src/routes/payouts.test.ts` | Comprehensive unit test suite |
| `src/index.ts` | App wiring with InMemoryPayoutRepository |

### Exported Functions

- **`createPayoutsHandlers(payoutRepo)`** — Factory returning `{ listPayouts }` handler
- **`createPayoutsRouter(opts)`** — Factory returning Express Router

## Security Assumptions

1. **User isolation**: Investors can only view their own payouts. The `investor_id` used for database filtering is extracted from the authenticated JWT, not from the request body or query string.

2. **Role enforcement**: Only users with `role === 'investor'` can access the endpoint. Startups, issuers, and admins receive HTTP 403.

3. **Input validation**: All query parameters are validated before processing. Invalid values return HTTP 400 with descriptive error messages. Unknown status values cannot bypass the enum check.

4. **Limit cap**: The `limit` parameter is capped at 100 to prevent denial-of-service via arbitrarily large result sets. Requests exceeding 100 are silently capped.

5. **Sort field allowlist**: Only `created_at`, `amount`, and `status` are accepted as `sortBy` values, preventing injection of arbitrary sort keys.

## Abuse/Failure Paths

| Attack Vector | Mitigation |
|--------------|------------|
| Enumerate another investor's payouts | `investor_id` from JWT, not query string |
| Request unbounded result set (`limit=999999`) | Capped at MAX_LIMIT (100) |
| Inject arbitrary sort field | Validated against allowlist |
| Non-numeric pagination values (`limit=abc`) | Returns 400 |
| Negative pagination values (`offset=-5`) | Returns 400 |
| Unknown status value (`status=xyz`) | Returns 400 |
| Invalid date format (`from=not-a-date`) | Returns 400 |
| Negative amount filter (`minAmount=-10`) | Returns 400 |
| Missing auth / expired JWT | Returns 401 |
| Non-investor role access | Returns 403 |
| Database connection failure | Forwarded to global error handler via `next(err)` |

## Testing Strategy

The test suite covers **40+ test cases** organized into:

- **Auth boundaries** (5 tests): 401 for missing/incomplete auth, 403 for non-investor roles
- **Basic listing** (4 tests): Investor isolation, empty results, response shape, default pagination
- **Status filter** (5 tests): All valid statuses, unknown status rejection
- **Pagination** (10 tests): Limit, offset, combined, negative values, non-numeric, max cap, large offset
- **Amount range filters** (8 tests): Min, max, both, invalid, negative, empty results
- **Date range filters** (6 tests): From, to, both, invalid dates, empty results
- **Sorting** (7 tests): Default order, ascending, by amount, by status, invalid sortBy/sortOrder
- **Combined filters** (2 tests): Multi-filter with sort and pagination, second page
- **Error handling** (1 test): Repository failure propagation

### Test Commands

```bash
# Run payout tests only
npx jest src/routes/payouts.test.ts --verbose

# Run with coverage
npx jest src/routes/payouts.test.ts --coverage --collectCoverageFrom="src/routes/payouts.ts"

# Full suite regression
npx jest --runInBand
```

## API Reference

### GET /api/investments/payouts

**Description**: Retrieve paginated, filtered, and sorted payouts for the authenticated investor.

**Authentication**: Required (JWT via `Authorization: Bearer <token>`)

**Role**: `investor` only

**Query Parameters**: See table above.

**Response 200**:
```json
{
  "payouts": [
    {
      "id": "pay-1",
      "distribution_run_id": "run-1",
      "investor_id": "inv-1",
      "amount": "100.00",
      "status": "processed",
      "transaction_hash": "0xabc",
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0,
  "hasMore": true
}
```

**Response 400**: Invalid query parameter
```json
{ "error": "Invalid status. Allowed: pending, processed, failed" }
```

**Response 401**: Unauthorized (missing/invalid JWT)

**Response 403**: Forbidden (non-investor role)

**Response 500**: Internal server error (database failure)
