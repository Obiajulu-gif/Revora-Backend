import express, { Request } from 'express';
import request from 'supertest';
import {
  createStartupAuthTierLimiter,
  STARTUP_AUTH_RATE_TIER_HEADER,
  STARTUP_AUTH_TIER_SECRET_HEADER,
} from './startupAuthRateTierPolicy';

describe('startupAuthRateTierPolicy', () => {
  const tierSecret = 'tier-secret-test';

  beforeEach(() => {
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  afterEach(() => {
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  function makeRequest(headers: Record<string, string> = {}): Request {
    return {
      header(name: string): string | undefined {
        return headers[name.toLowerCase()];
      },
    } as unknown as Request;
  }

  function makeApp() {
    const limiter = createStartupAuthTierLimiter();
    const app = express();
    app.use(express.json());
    app.post('/startup/register', limiter.middleware, (_req, res) => {
      res.status(201).json({ ok: true });
    });
    return { app, limiter };
  }

  it('resolves standard for missing tier header', () => {
    const limiter = createStartupAuthTierLimiter();
    const req = makeRequest();

    expect(limiter.resolveTier(req)).toBe('standard');
  });

  it('resolves standard for unknown requested tier', () => {
    const limiter = createStartupAuthTierLimiter();
    const req = makeRequest({ [STARTUP_AUTH_RATE_TIER_HEADER]: 'vip' });

    expect(limiter.resolveTier(req)).toBe('standard');
  });

  it('resolves trusted only when tier secret is valid', () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const limiter = createStartupAuthTierLimiter();

    const valid = makeRequest({
      [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
      [STARTUP_AUTH_TIER_SECRET_HEADER]: tierSecret,
    });
    const spoofed = makeRequest({
      [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
      [STARTUP_AUTH_TIER_SECRET_HEADER]: 'wrong',
    });

    expect(limiter.resolveTier(valid)).toBe('trusted');
    expect(limiter.resolveTier(spoofed)).toBe('standard');
  });

  it('sets X-RateLimit-Tier response header', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const { app } = makeApp();

    const res = await request(app)
      .post('/startup/register')
      .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
      .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
      .send({});

    expect(res.status).toBe(201);
    expect(res.headers['x-ratelimit-tier']).toBe('trusted');
  });

  it('enforces standard tier quota (6th request blocked)', async () => {
    const { app } = makeApp();

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/startup/register').send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-tier']).toBe('standard');
    }

    const blocked = await request(app).post('/startup/register').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('standard');
    expect(blocked.headers['x-ratelimit-limit']).toBe('5');
  });

  it('enforces trusted tier quota (11th request blocked)', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const { app } = makeApp();

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
        .send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-tier']).toBe('trusted');
    }

    const blocked = await request(app)
      .post('/startup/register')
      .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
      .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
      .send({});

    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('trusted');
    expect(blocked.headers['x-ratelimit-limit']).toBe('10');
  });

  it('enforces internal tier quota (26th request blocked)', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const { app } = makeApp();

    for (let i = 0; i < 25; i += 1) {
      const res = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'internal')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
        .send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-tier']).toBe('internal');
    }

    const blocked = await request(app)
      .post('/startup/register')
      .set(STARTUP_AUTH_RATE_TIER_HEADER, 'internal')
      .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
      .send({});

    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('internal');
    expect(blocked.headers['x-ratelimit-limit']).toBe('25');
  });

  it('reset clears rate-limit counters', async () => {
    const { app, limiter } = makeApp();

    for (let i = 0; i < 6; i += 1) {
      await request(app).post('/startup/register').send({});
    }

    limiter.reset();

    const res = await request(app).post('/startup/register').send({});
    expect(res.status).toBe(201);
  });
});
