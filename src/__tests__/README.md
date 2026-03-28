# End-to-End Happy Path Tests

## Overview

This directory contains comprehensive end-to-end tests for the Revora Backend API.

## Running Tests

```bash
# Install dependencies first
npm install

# Run all tests
npm test

# Run E2E tests only
npm run test:e2e

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch
```

## Test Files

- `e2e-happy-path.test.ts` - Comprehensive E2E happy path tests covering:
  - User registration and authentication
  - Offering creation and management
  - Investment creation and retrieval
  - Complete user journeys
  - Edge cases and security validation
  - Session management
  - JWT token management

## Coverage Requirements

- Minimum 95% coverage for statements, branches, functions, and lines
- Coverage reports are generated in the `coverage/` directory
- View HTML report: `open coverage/index.html`

## Documentation

See [docs/backend-end-to-end-happy-path-tests.md](../../docs/backend-end-to-end-happy-path-tests.md) for detailed documentation.
