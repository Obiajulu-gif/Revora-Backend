import { Request, Response } from 'express';
import { Pool } from 'pg';
import createHealthRouter, { healthReadyHandler } from './health';
import request from 'supertest';
import app, { __test } from '../index';
import { closePool } from '../db/client';

// Mock fetch for Stellar check
global.fetch = jest.fn();

const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 1200,
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await wait(20);
    }
    throw new Error('Timed out waiting for expected condition');
};

const waitForEventHealth = async (
    predicate: (events: Record<string, any>) => boolean,
    timeoutMs = 1500,
): Promise<Record<string, any>> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await request(app).get('/health');
        const events = res.body?.events;
        if (events && predicate(events)) {
            return events;
        }
        await wait(25);
    }
    throw new Error('Timed out waiting for expected event publisher health state');
};

afterAll(async () => {
    await closePool();
});

describe('Health Router', () => {
    let mockPool: jest.Mocked<Pool>;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let jsonMock: jest.Mock;
    let statusMock: jest.Mock;

    beforeEach(() => {
        mockPool = {
            query: jest.fn(),
        } as unknown as jest.Mocked<Pool>;

        jsonMock = jest.fn();
        statusMock = jest.fn().mockReturnValue({ json: jsonMock });

        mockReq = {};
        mockRes = {
            status: statusMock,
            json: jsonMock,
        };

        jest.clearAllMocks();
    });

    it('should return 200 when both DB and Stellar are up', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'ok', db: 'up', stellar: 'up' });
    });

    it('should return 503 when DB is down', async () => {
        (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('Connection timeout'));

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Database is down' });
        expect(global.fetch).not.toHaveBeenCalled(); // DB checked first
    });

    it('should return 503 when Stellar Horizon is down', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Stellar Horizon is down' });
    });

    it('should return 503 when Stellar Horizon returns non-OK status', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Stellar Horizon is down' });
    });

    it('should create returning router instance', () => {
        const router = createHealthRouter(mockPool);
        expect(router).toBeDefined();
        expect(typeof router.get).toBe('function');
    });
});

describe('API Version Prefix Consistency tests', () => {
    it('should resolve /health without API prefix', async () => {
        const res = await request(app).get('/health');
        expect([200, 503]).toContain(res.status);
    });

    it('should resolve api routes with API_VERSION_PREFIX', async () => {
        const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
        const res = await request(app).get(`${prefix}/overview`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('name', 'Stellar RevenueShare (Revora) Backend');
    });

    it('should return 404 for api routes without prefix', async () => {
        const res = await request(app).get('/overview');
        expect(res.status).toBe(404);
    });
    
    it('should correctly scope protected endpoints under the prefix', async () => {
        const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
        // Hit milestone validation route (requires auth)
        const res = await request(app).post(`${prefix}/vaults/vault-1/milestones/milestone-1/validate`);
        expect(res.status).toBe(401);
    });
    
    it('should 404 for protected endpoints if prefix is lacking', async () => {
        const res = await request(app).post('/vaults/vault-1/milestones/milestone-1/validate');
        expect(res.status).toBe(404);
    });
});

describe('Milestone Event Publishing Reliability', () => {
    it('should expose event publisher reliability metrics on /health', async () => {
        const res = await request(app).get('/health');
        expect(res.body).toHaveProperty('events');
        expect(res.body.events).toMatchObject({
            queued: expect.any(Number),
            inFlight: expect.any(Boolean),
            deadLetterCount: expect.any(Number),
            maxAttempts: expect.any(Number),
            retryBaseMs: expect.any(Number),
            queueCapacity: expect.any(Number),
        });
    });

    it('should validate a milestone and eventually drain the publish queue', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
            const res = await request(app)
                .post(`${prefix}/vaults/vault-1/milestones/milestone-1/validate`)
                .set('x-user-id', 'verifier-1')
                .set('x-user-role', 'verifier');

            expect(res.status).toBe(200);
            expect(res.body?.data?.validationEvent?.id).toBeTruthy();

            const events = await waitForEventHealth(
                (eventState) =>
                    eventState.queued === 0 &&
                    eventState.deadLetterCount === 0 &&
                    Boolean(eventState.lastPublishedAt),
            );
            expect(events.lastError).toBeNull();
        } finally {
            logSpy.mockRestore();
        }
    });

    it('should enforce verifier role boundaries on milestone validation', async () => {
        const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
        const res = await request(app)
            .post(`${prefix}/vaults/vault-1/milestones/milestone-3/validate`)
            .set('x-user-id', 'verifier-1')
            .set('x-user-role', 'investor');

        expect(res.status).toBe(403);
    });

    it('should dead-letter events after bounded retries when transport keeps failing', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            const message = args[0];
            if (typeof message === 'string' && message.startsWith('[domain-event]')) {
                throw new Error('forced_domain_event_publish_failure');
            }
        });

        try {
            const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
            const res = await request(app)
                .post(`${prefix}/vaults/vault-1/milestones/milestone-2/validate`)
                .set('x-user-id', 'verifier-1')
                .set('x-user-role', 'verifier');

            expect(res.status).toBe(200);
            expect(res.body?.data?.validationEvent?.id).toBeTruthy();

            const events = await waitForEventHealth(
                (eventState) => eventState.queued === 0 && eventState.deadLetterCount >= 1,
            );
            expect(events.lastError).toContain('forced_domain_event_publish_failure');

            const healthRes = await request(app).get('/health');
            expect(healthRes.status).toBe(503);
            expect(healthRes.body.status).toBe('degraded');
        } finally {
            logSpy.mockRestore();
        }
    });
});

describe('Event Publisher Internal Reliability Units', () => {
    it('should parse positive ints and fallback for invalid values', () => {
        expect(__test.parsePositiveInt('42', 5)).toBe(42);
        expect(__test.parsePositiveInt('0', 5)).toBe(5);
        expect(__test.parsePositiveInt(undefined, 5)).toBe(5);
        expect(__test.parsePositiveInt('abc', 5)).toBe(5);
    });

    it('should produce stable serialization for arrays and object keys', () => {
        const serialized = __test.stableSerialize({ b: 2, a: [3, 1] });
        expect(serialized).toBe('{"a":[3,1],"b":2}');
    });

    it('should reject invalid event name and invalid payload', async () => {
        const transport = {
            publish: jest.fn().mockResolvedValue(undefined),
        };
        const publisher = __test.createReliableMilestoneEventPublisher(transport);

        await expect(
            publisher.publish('!', { validationEventId: 'ev-1' }),
        ).rejects.toThrow('Invalid domain event name format');

        await expect(
            publisher.publish('vault.milestone.validated', [] as unknown as Record<string, unknown>),
        ).rejects.toThrow('Domain event payload must be a non-array object');
    });

    it('should deduplicate successfully published events by identity', async () => {
        const transport = {
            publish: jest.fn().mockResolvedValue(undefined),
        };
        const publisher = __test.createReliableMilestoneEventPublisher(transport, {
            dedupeTtlMs: 5000,
        });

        await publisher.publish('vault.milestone.validated', { validationEventId: 'dedupe-1' });
        await waitFor(() => transport.publish.mock.calls.length === 1);

        await publisher.publish('vault.milestone.validated', { validationEventId: 'dedupe-1' });
        await wait(30);

        expect(transport.publish).toHaveBeenCalledTimes(1);
        expect(publisher.getHealthSnapshot().deadLetterCount).toBe(0);
    });

    it('should dead-letter overflowed events and enforce dead-letter capacity', async () => {
        const transport = {
            publish: jest.fn().mockResolvedValue(undefined),
        };
        const publisher = __test.createReliableMilestoneEventPublisher(transport, {
            queueCapacity: 0,
            deadLetterCapacity: 1,
        });

        await publisher.publish('vault.milestone.validated', { validationEventId: 'overflow-1' });
        await publisher.publish('vault.milestone.validated', { validationEventId: 'overflow-2' });

        const health = publisher.getHealthSnapshot();
        expect(health.deadLetterCount).toBe(1);
        expect(health.queued).toBe(0);
        expect(publisher.isHealthy()).toBe(false);
    });

    it('should retry and normalize unknown publish errors before dead-lettering', async () => {
        const transport = {
            publish: jest.fn().mockRejectedValue('raw_failure_value'),
        };
        const publisher = __test.createReliableMilestoneEventPublisher(transport, {
            maxAttempts: 1,
            retryBaseMs: 1,
        });

        await publisher.publish('vault.milestone.validated', { validationEventId: 'fail-1' });
        await waitFor(() => publisher.getHealthSnapshot().deadLetterCount === 1);

        expect(publisher.getHealthSnapshot().lastError).toBe('unknown_publish_error');
    });

    it('should avoid duplicate processing while already in-flight', async () => {
        let resolveFirstPublish: (() => void) | undefined;
        const firstPublishDone = new Promise<void>((resolve) => {
            resolveFirstPublish = resolve;
        });

        const transport = {
            publish: jest.fn().mockImplementation(() => firstPublishDone),
        };

        const publisher = __test.createReliableMilestoneEventPublisher(transport);
        await publisher.publish('vault.milestone.validated', { validationEventId: 'inflight-1' });
        await publisher.publish('vault.milestone.validated', { validationEventId: 'inflight-2' });

        await wait(30);
        expect(transport.publish).toHaveBeenCalledTimes(1);

        resolveFirstPublish?.();
        await waitFor(() => transport.publish.mock.calls.length === 2);
        await publisher.shutdown();
    });
});
