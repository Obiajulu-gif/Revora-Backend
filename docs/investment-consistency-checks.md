# Investment Consistency Checks

## Overview

This document describes the investment consistency check system
implemented in `Revora-Backend`. It enforces strict rules about
when and how investments can be made in an offering — preventing
invalid amounts, wrong offering states, and missing required fields.

---

## Rules Enforced

An investment is only valid when ALL of the following are true:

- The offering status is `published`
- The investment amount is a positive finite number
- The investor ID is provided
- The offering ID is provided

---

## Investable Statuses

| Status         | Can Receive Investment |
|----------------|------------------------|
| draft          | No                     |
| pending_review | No                     |
| approved       | No                     |
| rejected       | No                     |
| published      | Yes ✅                 |
| archived       | No                     |

---

## Implementation

**File:** `src/lib/investmentConsistencyGuard.ts`

### `canInvest(offeringStatus): boolean`
Returns `true` if the offering status allows investments.
Does not throw — safe to use for conditional checks.

### `isValidAmount(amount): boolean`
Returns `true` if the amount is a positive finite number.
Returns `false` for zero, negative, or infinite values.

### `enforceInvestmentConsistency(input): void`
Throws a descriptive `Error` if any of these are violated:
- `offeringId` is missing
- `investorId` is missing
- `offeringStatus` is missing
- Offering status is not `published`
- Amount is missing
- Amount is not a positive finite number

Use this in route handlers where an invalid investment must halt execution.

---

## Security Assumptions

- The route `POST /offerings/:id/invest` requires authentication via
  the `requireAuth` middleware. Unauthenticated requests receive a `401`.
- Only `published` offerings can receive investments — this prevents
  investing in offerings that are under review, rejected, or closed.
- Amount is validated as a positive finite number — negative amounts
  and zero amounts are explicitly blocked.
- Both `investorId` and `offeringId` are required — anonymous or
  unlinked investments are rejected.

---

## Abuse and Failure Paths

| Scenario                          | Behaviour                                        |
|-----------------------------------|--------------------------------------------------|
| Missing `offeringId`              | Throws `Offering ID is required`                 |
| Missing `investorId`              | Throws `Investor ID is required`                 |
| Missing `offeringStatus`          | Throws `Offering status is required`             |
| Offering not published            | Throws `Offering is not open for investment`     |
| Amount is zero                    | Throws `Investment amount must be a positive number` |
| Amount is negative                | Throws `Investment amount must be a positive number` |
| Amount is Infinity                | Throws `Investment amount must be a positive number` |
| Unauthenticated request           | Returns `401 Unauthorized`                       |
| Offering not found                | Returns `404 Offering not found`                 |

---

## Test Coverage

**File:** `src/routes/health.test.ts`

| Test                                      | What it verifies                          |
|-------------------------------------------|-------------------------------------------|
| allows investment in a published offering | `canInvest("published")` returns true     |
| blocks investment in a draft offering     | `canInvest("draft")` returns false        |
| blocks investment in a pending_review offering | `canInvest("pending_review")` returns false |
| blocks investment in an archived offering | `canInvest("archived")` returns false     |
| validates a positive amount               | `isValidAmount(100)` returns true         |
| rejects a zero amount                     | `isValidAmount(0)` returns false          |
| rejects a negative amount                 | `isValidAmount(-50)` returns false        |
| rejects a non-finite amount               | `isValidAmount(Infinity)` returns false   |
| throws when offering is not published     | enforceInvestmentConsistency throws       |
| throws when amount is zero                | enforceInvestmentConsistency throws       |
| throws when amount is negative            | enforceInvestmentConsistency throws       |
| throws when investorId is missing         | enforceInvestmentConsistency throws       |
| throws when offeringId is missing         | enforceInvestmentConsistency throws       |
| passes all checks for a valid investment  | enforceInvestmentConsistency does not throw |

---

## Example Usage
```typescript
import { enforceInvestmentConsistency } from '../lib/investmentConsistencyGuard';

// Inside a route handler:
enforceInvestmentConsistency({
  offeringStatus: offering.status,
  amount,
  investorId,
  offeringId: offering.id,
});
// If this line does not throw, the investment is safe to process.
```

---

## Related Files

- `src/lib/investmentConsistencyGuard.ts` — core guard logic
- `src/index.ts` — route handler for `POST /offerings/:id/invest`
- `src/routes/health.test.ts` — full test suite