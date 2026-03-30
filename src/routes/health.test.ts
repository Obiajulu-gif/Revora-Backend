import { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { app, __test, classifyStellarRPCFailure, StellarRPCFailureClass } from '../index';
import { ErrorCode } from '../lib/errors';
import { errorHandler } from '../middleware/errorHandler';
import { createHealthRouter, healthReadyHandler, mapHealthDependencyFailure } from './health';

function makeResponseDouble() {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return response;
}

describe('classifyStellarRPCFailure', () => {
  it('classifies timeout failures', () => {
    const error = new Error('network timeout');
    error.name = 'AbortError';

    expect(classifyStellarRPCFailure(error)).toBe(StellarRPCFailureClass.TIMEOUT);
  });

  it('classifies rate-limit failures', () => {
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

  it('falls back to unknown for non-matching failures', () => {
    expect(classifyStellarRPCFailure(new Error('random failure'))).toBe(
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

  it('includes stellar failure class and upstream status when present', () => {
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
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('returns ok when database and stellar checks pass', async () => {
    const db = { query: jest.fn().mockResolvedValue(undefined) };
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as unknown as globalThis.Response);

    const req = {} as Request;
    const res = makeResponseDouble();
    const next = jest.fn() as NextFunction;

    await healthReadyHandler(db)(req, res, next);

    expect(db.query).toHaveBeenCalledWith('SELECT 1');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok', db: 'up', stellar: 'up' });
  });

  it('forwards sanitized database failure', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as unknown as globalThis.Response);

    const req = {} as Request;
    const res = makeResponseDouble();
    const next = jest.fn() as NextFunction;

    await healthReadyHandler(db)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const error = (next as jest.Mock).mock.calls[0][0];
    expect(error.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: { dependency: 'database' },
    });
  });

  it('forwards stellar upstream error when stellar responds non-2xx', async () => {
    const db = { query: jest.fn().mockResolvedValue(undefined) };
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 503 } as unknown as globalThis.Response);

    const req = {} as Request;
    const res = makeResponseDouble();
    const next = jest.fn() as NextFunction;

    await healthReadyHandler(db)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const error = (next as jest.Mock).mock.calls[0][0];
    expect(error.toResponse()).toEqual({
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

describe('createHealthRouter', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('serves /health/ready with 200 when dependencies are healthy', async () => {
    const db = { query: jest.fn().mockResolvedValue(undefined) };
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as unknown as globalThis.Response);

    const testApp = express();
    testApp.use('/health', createHealthRouter(db));
    testApp.use(errorHandler);

    const response = await request(testApp).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'up', stellar: 'up' });
  });

  it('returns dependency-unavailable error shape when db check fails', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('connection refused')) };
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as unknown as globalThis.Response);

    const testApp = express();
    testApp.use('/health', createHealthRouter(db));
    testApp.use(errorHandler);

    const response = await request(testApp).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'database',
      },
    });
  });
});

describe('Startup Auth Rate Limiter Tier Policies', () => {
  const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
  const tierHeader = 'x-revora-rate-tier';
  const tierSecretHeader = 'x-revora-tier-secret';
  const tierSecret = 'startup-rate-tier-secret-test';

  beforeEach(() => {
    __test.resetStartupAuthRateLimitState();
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  afterEach(() => {
    __test.resetStartupAuthRateLimitState();
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  async function sendStartupRegistration(
    scope: string,
    attempt: number,
    extraHeaders: Record<string, string> = {},
  ) {
    return request(app)
      .post(`${prefix}/startup/register`)
      .set(extraHeaders)
      .send({
        email: `${scope}-${attempt}@example.com`,
        password: 'StrongPwd!9K',
        name: `User ${attempt}`,
      });
  }

  it('defaults to standard tier and blocks the 6th request', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const response = await sendStartupRegistration('standard', i);
      expect(response.status).not.toBe(429);
      expect(response.headers['x-ratelimit-tier']).toBe('standard');
    }

    const blocked = await sendStartupRegistration('standard', 6);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('standard');
    expect(blocked.headers['x-ratelimit-limit']).toBe('5');
    expect(blocked.body).toMatchObject({
      error: 'TooManyRequests',
      message: expect.stringContaining('Too many registration attempts'),
    });
  });

  it('applies trusted tier when header and secret are valid', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const trustedHeaders = {
      [tierHeader]: 'trusted',
      [tierSecretHeader]: tierSecret,
    };

    for (let i = 1; i <= 10; i += 1) {
      const response = await sendStartupRegistration('trusted', i, trustedHeaders);
      expect(response.status).not.toBe(429);
      expect(response.headers['x-ratelimit-tier']).toBe('trusted');
    }

    const blocked = await sendStartupRegistration('trusted', 11, trustedHeaders);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('trusted');
    expect(blocked.headers['x-ratelimit-limit']).toBe('10');
  });

  it('falls back to standard tier when trusted is spoofed without a valid secret', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const spoofedHeaders = {
      [tierHeader]: 'trusted',
    };

    for (let i = 1; i <= 5; i += 1) {
      const response = await sendStartupRegistration('spoofed', i, spoofedHeaders);
      expect(response.status).not.toBe(429);
      expect(response.headers['x-ratelimit-tier']).toBe('standard');
    }

    const blocked = await sendStartupRegistration('spoofed', 6, spoofedHeaders);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('standard');
    expect(blocked.headers['x-ratelimit-limit']).toBe('5');
  });

  it('supports internal tier with valid secret and enforces its larger quota', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const internalHeaders = {
      [tierHeader]: 'internal',
      [tierSecretHeader]: tierSecret,
    };

    for (let i = 1; i <= 25; i += 1) {
      const response = await sendStartupRegistration('internal', i, internalHeaders);
      expect(response.status).not.toBe(429);
      expect(response.headers['x-ratelimit-tier']).toBe('internal');
    }

    const blocked = await sendStartupRegistration('internal', 26, internalHeaders);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('internal');
    expect(blocked.headers['x-ratelimit-limit']).toBe('25');
  });

  it('resolves tier helper deterministically', () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;

    const trustedReq = {
      header: (name: string) => {
        const headers: Record<string, string> = {
          [tierHeader]: 'trusted',
          [tierSecretHeader]: tierSecret,
        };
        return headers[name.toLowerCase()];
      },
    } as unknown as Request;

    const spoofedReq = {
      header: (name: string) => {
        const headers: Record<string, string> = {
          [tierHeader]: 'internal',
          [tierSecretHeader]: 'wrong',
        };
        return headers[name.toLowerCase()];
      },
    } as unknown as Request;

    expect(__test.resolveStartupAuthRateTier(trustedReq)).toBe('trusted');
    expect(__test.resolveStartupAuthRateTier(spoofedReq)).toBe('standard');
  });

  it('does not affect /health when startup endpoint is rate-limited', async () => {
    for (let i = 1; i <= 6; i += 1) {
      await sendStartupRegistration('isolation', i);
    }

    const health = await request(app).get('/health');
    expect([200, 503]).toContain(health.status);
    expect(health.status).not.toBe(429);
  });
});
