import express from 'express';
import request from 'supertest';
import {
  __test,
  classifyStellarRPCFailure,
  createApp,
  StellarRPCFailureClass,
  WebhookQueue,
} from '../index';
import { closePool } from '../db/client';
import { ErrorCode } from '../lib/errors';
import {
  createHealthRouter,
  healthReadyHandler,
  mapHealthDependencyFailure,
} from './health';

afterAll(async () => {
  await closePool();
});

describe('classifyStellarRPCFailure', () => {
  it('classifies timeout failures', () => {
    const error = new Error('network timeout');
    error.name = 'AbortError';

    expect(classifyStellarRPCFailure(error)).toBe(StellarRPCFailureClass.TIMEOUT);
  });

  it('classifies rate limit failures', () => {
    expect(classifyStellarRPCFailure({ status: 429 })).toBe(
      StellarRPCFailureClass.RATE_LIMIT,
    );
  });

  it('classifies auth failures', () => {
    expect(classifyStellarRPCFailure({ status: 401 })).toBe(
      StellarRPCFailureClass.UNAUTHORIZED,
    );
    expect(classifyStellarRPCFailure({ status: 403 })).toBe(
      StellarRPCFailureClass.UNAUTHORIZED,
    );
  });

  it('classifies upstream 5xx failures', () => {
    expect(classifyStellarRPCFailure({ status: 503 })).toBe(
      StellarRPCFailureClass.UPSTREAM_ERROR,
    );
  });

  it('classifies malformed responses', () => {
    expect(classifyStellarRPCFailure(new SyntaxError('bad json'))).toBe(
      StellarRPCFailureClass.MALFORMED_RESPONSE,
    );
  });

  it('falls back to unknown for uncategorized errors', () => {
    expect(classifyStellarRPCFailure(new Error('something odd'))).toBe(
      StellarRPCFailureClass.UNKNOWN,
    );
  });
});

describe('mapHealthDependencyFailure', () => {
  it('sanitizes database dependency errors', () => {
    const mapped = mapHealthDependencyFailure('database', new Error('password auth failed'));

    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'database',
      },
    });
  });

  it('preserves stable Stellar metadata without leaking raw upstream details', () => {
    const mapped = mapHealthDependencyFailure('stellar-horizon', { status: 503 });

    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'stellar-horizon',
        failureClass: StellarRPCFailureClass.UPSTREAM_ERROR,
        upstreamStatus: 503,
      },
    });
  });
});

describe('healthReadyHandler', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns ok when both database and horizon are healthy', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get('/ready', healthReadyHandler(db));

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      db: 'up',
      stellar: 'up',
    });
  });

  it('surfaces sanitized database failures', async () => {
    const db = {
      query: jest.fn().mockRejectedValue(new Error('connection string leaked')),
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get('/ready', healthReadyHandler(db));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const mapped = err as { statusCode: number; toResponse: () => unknown };
      res.status(mapped.statusCode).json(mapped.toResponse());
    });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'database',
      },
    });
  });

  it('maps Stellar upstream failures deterministically', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 }) as typeof fetch;

    const app = express();
    app.use('/health', createHealthRouter(db));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const mapped = err as { statusCode: number; toResponse: () => unknown };
      res.status(mapped.statusCode).json(mapped.toResponse());
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'stellar-horizon',
        failureClass: StellarRPCFailureClass.RATE_LIMIT,
        upstreamStatus: 429,
      },
    });
  });
});

describe('offering validation matrix', () => {
  const path = '/api/v1/offerings/validation-matrix';

  function buildApp() {
    return createApp({
      healthStatus: jest.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
      healthQuery: jest.fn(),
    });
  }

  function authHeaders(role: string, id = 'actor-1') {
    return {
      'x-user-id': id,
      'x-user-role': role,
    };
  }

  it('rejects unauthenticated callers at the auth boundary', async () => {
    const response = await request(buildApp())
      .post(path)
      .send({
        action: 'create',
        offering: { targetAmount: '1000.00', minimumInvestment: '50.00' },
      });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Offering validation requires x-user-id and x-user-role headers',
    });
  });

  it('rejects invalid actions with an explicit schema error', async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders('startup'))
      .send({
        action: 'destroy',
        offering: {},
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      message: 'Invalid offering validation action',
    });
  });

  it('allows a startup to publish its own valid draft offering', async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders('startup', 'issuer-1'))
      .send({
        action: 'publish',
        offering: {
          id: 'off-1',
          issuerId: 'issuer-1',
          status: 'draft',
          targetAmount: '1000.00',
          minimumInvestment: '50.00',
          subscriptionStartsAt: '2030-01-01T00:00:00.000Z',
          subscriptionEndsAt: '2030-01-15T00:00:00.000Z',
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.allowed).toBe(true);
    expect(response.body.decision).toBe('allow');
    expect(response.body.violations).toEqual([]);
  });

  it('denies a startup from managing another issuers offering', async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders('startup', 'issuer-1'))
      .send({
        action: 'pause',
        offering: {
          id: 'off-2',
          issuerId: 'issuer-2',
          status: 'open',
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toBe(false);
    expect(response.body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OWNERSHIP_CONFIRMED',
        }),
      ]),
    );
  });

  it('denies investment attempts outside the allowed subscription window', async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders('investor', 'investor-1'))
      .send({
        action: 'invest',
        offering: {
          id: 'off-3',
          issuerId: 'issuer-3',
          status: 'open',
          targetAmount: '1000.00',
          minimumInvestment: '100.00',
          investmentAmount: '125.00',
          subscriptionStartsAt: '2020-01-01T00:00:00.000Z',
          subscriptionEndsAt: '2020-01-15T00:00:00.000Z',
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toBe(false);
    expect(response.body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVESTMENT_WINDOW_ACTIVE',
        }),
      ]),
    );
  });

  it('blocks issuer self-investment by default', async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders('investor', 'issuer-4'))
      .send({
        action: 'invest',
        offering: {
          id: 'off-4',
          issuerId: 'issuer-4',
          status: 'open',
          targetAmount: '500.00',
          minimumInvestment: '50.00',
          investmentAmount: '50.00',
          subscriptionStartsAt: '2030-01-01T00:00:00.000Z',
          subscriptionEndsAt: '2030-01-10T00:00:00.000Z',
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toBe(false);
    expect(response.body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVESTOR_NOT_ISSUER',
        }),
      ]),
    );
  });

  it('allows privileged compliance actors to review private offerings without ownership', async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders('compliance', 'compliance-1'))
      .send({
        action: 'viewPrivate',
        offering: {
          id: 'off-5',
          issuerId: 'issuer-99',
          status: 'paused',
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.allowed).toBe(true);
    expect(response.body.violations).toEqual([]);
  });

  it('returns degraded root health when the dependency checker reports failure', async () => {
    const app = createApp({
      healthStatus: jest.fn().mockResolvedValue({
        healthy: false,
        latencyMs: 4,
        error: 'sanitized-db-error',
      }),
      healthQuery: jest.fn(),
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'degraded',
      service: 'revora-backend',
      db: {
        healthy: false,
        latencyMs: 4,
        error: 'sanitized-db-error',
      },
    });
  });

  it('serves the overview document on the versioned API prefix', async () => {
    const response = await request(buildApp()).get('/api/v1/overview');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'Stellar RevenueShare (Revora) Backend',
      version: '0.1.0',
    });
  });

  it('rate limits repeated startup registration attempts on the versioned route', async () => {
    const app = buildApp();

    for (let i = 0; i < 5; i += 1) {
      const response = await request(app)
        .post('/api/v1/startup/register')
        .send({ email: `founder-${i}@example.com`, password: 'VeryStrongPass!9' });

      expect(response.status).toBe(201);
      expect(response.headers['x-ratelimit-limit']).toBe('5');
    }

    const blocked = await request(app)
      .post('/api/v1/startup/register')
      .send({ email: 'founder-6@example.com', password: 'VeryStrongPass!9' });

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: 'TooManyRequests',
      message: 'Too many registration attempts',
    });
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('rejects startup registration payloads that omit required credentials', async () => {
    const response = await request(buildApp())
      .post('/api/v1/startup/register')
      .send({ email: 'missing-password@example.com' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Email and password are required',
    });
  });
});

describe('WebhookQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('classifies safe and unsafe webhook targets correctly', () => {
    const isSafeUrl = (WebhookQueue as unknown as { isSafeUrl: (url: string) => boolean }).isSafeUrl;

    expect(isSafeUrl('https://example.com/hooks')).toBe(true);
    expect(isSafeUrl('http://127.0.0.1')).toBe(false);
    expect(isSafeUrl('http://localhost')).toBe(false);
    expect(isSafeUrl('not-a-valid-url')).toBe(false);
  });

  it('uses exponential backoff and stops after the configured retry ceiling', async () => {
    const deliveryPromise = WebhookQueue.processDelivery('https://example.com/hooks', {
      event: 'test',
    });

    await jest.advanceTimersByTimeAsync(31_000);

    await expect(deliveryPromise).resolves.toBe(false);
    expect(WebhookQueue.getBackoffDelay(0)).toBe(1000);
    expect(WebhookQueue.getBackoffDelay(5)).toBe(-1);
  });

  it('fails fast for unsafe SSRF-style destinations', async () => {
    await expect(
      WebhookQueue.processDelivery('http://192.168.1.10/internal', { event: 'test' }),
    ).resolves.toBe(false);
  });
});

describe('__test helpers', () => {
  it('stableSerialize sorts object keys recursively', () => {
    expect(
      __test.stableSerialize({
        b: 1,
        a: { d: 4, c: 3 },
      }),
    ).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('stableSerialize preserves arrays while sorting nested object keys', () => {
    expect(
      __test.stableSerialize([
        { z: 2, a: 1 },
        { b: 2, a: 1 },
      ]),
    ).toBe('[{"a":1,"z":2},{"a":1,"b":2}]');
  });

  it('parseMoneyString accepts bounded decimal strings and rejects invalid input', () => {
    expect(__test.parseMoneyString('999.99')).toBe(999.99);
    expect(__test.parseMoneyString('1e6')).toBeNull();
    expect(__test.parseMoneyString(10)).toBeNull();
  });

  it('parseIsoDate accepts valid ISO strings and rejects invalid dates', () => {
    expect(__test.parseIsoDate('2030-01-01T00:00:00.000Z')?.toISOString()).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    expect(__test.parseIsoDate('definitely-not-a-date')).toBeNull();
  });

  it('parseOfferingValidationPayload preserves trimmed deterministic values', () => {
    expect(
      __test.parseOfferingValidationPayload({
        action: 'create',
        offering: {
          issuerId: ' issuer-1 ',
          targetAmount: '100.00',
          minimumInvestment: '10.00',
        },
      }),
    ).toEqual({
      action: 'create',
      offering: {
        issuerId: 'issuer-1',
        targetAmount: '100.00',
        minimumInvestment: '10.00',
      },
    });
  });

  it('parseOfferingValidationPayload rejects malformed bodies and invalid field values', () => {
    expect(() => __test.parseOfferingValidationPayload(null)).toThrow(
      'Validation payload must be a JSON object',
    );
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: 'create',
      }),
    ).toThrow('Offering validation payload must include an offering object');
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: 'create',
        offering: { id: '   ' },
      }),
    ).toThrow('offering.id must be a non-empty string');
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: 'create',
        offering: { issuerId: '' },
      }),
    ).toThrow('offering.issuerId must be a non-empty string');
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: 'create',
        offering: { status: 'live' },
      }),
    ).toThrow('offering.status must be a supported offering status');
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: 'create',
        offering: { targetAmount: '' },
      }),
    ).toThrow('offering.targetAmount must be a non-empty string');
  });

  it('evaluateOfferingValidationMatrix covers close, cancel, and missing investment window rules', () => {
    const actor = { id: 'issuer-1', role: 'startup' as const };

    const closeResult = __test.evaluateOfferingValidationMatrix(actor, {
      action: 'close',
      offering: {
        issuerId: 'issuer-1',
        status: 'paused',
      },
    });
    expect(closeResult.allowed).toBe(true);

    const cancelResult = __test.evaluateOfferingValidationMatrix(actor, {
      action: 'cancel',
      offering: {
        issuerId: 'issuer-1',
        status: 'closed',
      },
    });
    expect(cancelResult.allowed).toBe(false);
    expect(cancelResult.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STATUS_ELIGIBLE_FOR_CANCEL' }),
      ]),
    );

    const investResult = __test.evaluateOfferingValidationMatrix(
      { id: 'investor-1', role: 'investor' },
      {
        action: 'invest',
        offering: {
          issuerId: 'issuer-2',
          status: 'open',
          targetAmount: '1000.00',
          minimumInvestment: '50.00',
          investmentAmount: '50.00',
        },
      },
      new Date('2030-01-05T00:00:00.000Z'),
    );

    expect(investResult.allowed).toBe(false);
    expect(investResult.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVESTMENT_WINDOW_ACTIVE' }),
      ]),
    );
  });
});
