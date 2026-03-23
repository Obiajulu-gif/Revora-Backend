# API Version Prefix Consistency

## Overview
This document details the standardization of the API version prefix across the Revora Backend services. The system relies on an environment variable `API_VERSION_PREFIX` with a default of `/api/v1` to namespace all API endpoints.

## Implementation Details
- The version prefix is centrally managed in `src/index.ts`.
- Non-API endpoints such as infrastructure and operational routes (e.g. `/health`) intentionally omit the prefix to maintain predictable tooling integrations explicitly separate from business logic routing.
- All internal domains, endpoints, and authenticated operations run exclusively through the prefixed router.

## Security Assumptions & Abuse/Failure Paths
1. **Unprefixed Access Denial:** Any API route accessed without the proper version prefix will correctly default into the application's wildcard 404 response. No unversioned fallback exists for API logic domains, effectively preventing version confusion attacks.
2. **Explicit Auth Boundary Constraints:** Authentication checks are bound exclusively within the prefixed API router or specific mounted sub-routers. No bypassing happens because any access to `/*` outside of API prefix (except explicit bypass for health/metrics) will simply hard-fail to hit business routes.
3. **Graceful Failures:** If `API_VERSION_PREFIX` configuration crashes or loads incorrectly, the fallback `/api/v1` ensures continuous system capability without exposing internal routes to accidental root mounting.

## Testing Strategy
- Core test `Revora-Backend/src/routes/health.test.ts` is explicitly extended to check expected endpoint scoping across generic and protected domains.
- Verified missing prefix results deterministically into 404 for API resources.
- Validated prefix propagates gracefully to internal routes.
