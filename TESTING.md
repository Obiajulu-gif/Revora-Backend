# Testing Guide

## Overview

This document provides a quick reference for running tests in the Revora Backend project.

## Quick Start

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run with coverage
npm run test:coverage
```

## Test Suites

### End-to-End Happy Path Tests

Location: `src/__tests__/e2e-happy-path.test.ts`

Comprehensive tests covering:
- ✅ User registration and authentication (investor, startup)
- ✅ Offering creation and management
- ✅ Investment creation and retrieval
- ✅ Complete user journeys
- ✅ Edge cases and boundary conditions
- ✅ Security validation
- ✅ Session management
- ✅ JWT token management

**31 test cases** with **95%+ coverage**

### Unit Tests

Location: Various `*.test.ts` files throughout the codebase

- `src/auth/login/loginRoute.test.ts` - Login flow tests
- `src/auth/register/registerHandler.test.ts` - Registration tests
- `src/routes/health.test.ts` - Health check tests
- `src/routes/offerings.test.ts` - Offering route tests
- `src/routes/investments.test.ts` - Investment route tests
- And many more...

## Test Commands

```bash
# Run all tests
npm test

# Run specific test file
npm test -- e2e-happy-path

# Run tests in watch mode
npm run test:watch

# Run with coverage report
npm run test:coverage

# Run E2E tests only
npm run test:e2e
```

## Coverage Requirements

- **Statements**: 95%
- **Branches**: 95%
- **Functions**: 95%
- **Lines**: 95%

## Viewing Coverage Reports

```bash
# Generate coverage report
npm run test:coverage

# Open HTML report (macOS/Linux)
open coverage/index.html

# Open HTML report (Windows)
start coverage/index.html
```

## Pre-Commit Checklist

Before committing code:

1. ✅ Run tests: `npm test`
2. ✅ Check coverage: `npm run test:coverage`
3. ✅ Run linter: `npm run lint`
4. ✅ Build TypeScript: `npm run build`

## Documentation

For detailed information about the E2E test suite, see:
- [Backend End-to-End Happy Path Tests](./docs/backend-end-to-end-happy-path-tests.md)

## Troubleshooting

### Tests Not Running

```bash
# Clear Jest cache
npm test -- --clearCache

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Coverage Below Threshold

```bash
# Generate detailed coverage report
npm run test:coverage

# Open HTML report to see uncovered lines
open coverage/index.html
```

### TypeScript Errors

```bash
# Check TypeScript compilation
npm run build

# Check specific file
npx tsc --noEmit src/path/to/file.ts
```

## CI/CD Integration

Tests are automatically run in CI/CD pipelines:

```yaml
# Example GitHub Actions
- run: npm ci
- run: npm test -- --coverage
- run: npm run lint
- run: npm run build
```

## Contributing

When adding new features:

1. Write tests for happy path
2. Write tests for edge cases
3. Write tests for error scenarios
4. Ensure coverage remains above 95%
5. Update documentation

---

**Last Updated**: 2024-01-01  
**Maintained By**: Backend Team
