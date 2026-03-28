# Stellar RPC Failure Classification

## Overview
The Revora backend implements a deterministic failure classification system for Stellar RPC providers (e.g., Horizon). This system ensures that upstream operational issues are categorized into stable, machine-readable classes while maintaining security by never exposing raw upstream error messages to clients.

## Failure Classes
| Class | Description | Trigger |
|-------|-------------|---------|
| `TIMEOUT` | Request timed out | Network timeout or AbortError |
| `RATE_LIMIT` | Provider rate limit reached | HTTP 429 |
| `UPSTREAM_ERROR` | Provider internal error | HTTP 5xx |
| `MALFORMED_RESPONSE` | Invalid JSON or structure | SyntaxError during parsing |
| `UNAUTHORIZED` | Authentication failure | HTTP 401/403 |
| `UNKNOWN` | Uncategorized failure | Any other error |

## Implementation Details
The classification logic is centralized in `src/index.ts` to provide a global standard for the application.

### Security Assumptions
1. **No Reconnaissance**: Raw upstream error messages are intentionally suppressed. Only the failure class and sanitized status codes are returned to clients.
2. **Deterministic Mapping**: Errors are mapped based on stable properties (HTTP status, error name) rather than transient message strings where possible.
3. **Fail-Safe**: Any unrecognized error is classified as `UNKNOWN` to avoid leaking implementation details.

## Usage in Health Checks
The `/health/ready` endpoint uses this classification to provide detailed dependency status:

```json
{
  "code": "SERVICE_UNAVAILABLE",
  "message": "Dependency unavailable",
  "details": {
    "dependency": "stellar-horizon",
    "failureClass": "RATE_LIMIT",
    "upstreamStatus": 429
  }
}
```

## Testing
Comprehensive test coverage is maintained in `src/routes/health.test.ts`, covering:
- Correct classification of HTTP status codes.
- Handling of network timeouts.
- Detection of malformed upstream responses.
- Verification that sensitive error details are not leaked.
