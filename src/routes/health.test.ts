import { Request, Response } from 'express';
import { Pool } from 'pg';
import { healthReadyHandler } from './health';
import { createRequireAuth } from '../middleware/auth';
import { issueToken } from '../lib/jwt';
import { hashSessionToken } from '../auth/session';

// Mock fetch for Stellar check
global.fetch = jest.fn();

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

  it('should authorize a valid session through createRequireAuth', async () => {
    const token = issueToken({ subject: 'user-1', additionalPayload: { sid: 'session-abc' }, expiresIn: '1h' });
    const tokenHash = hashSessionToken(token);

    const fakeSessionRepo = {
      findById: jest.fn().mockResolvedValueOnce({
        id: 'session-abc',
        user_id: 'user-1',
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        created_at: new Date(),
      }),
    } as any;

    const requireAuth = createRequireAuth(fakeSessionRepo);
    const next = jest.fn();
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = { status: statusMock, json: jsonMock } as unknown as Response;

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).auth).toEqual({ userId: 'user-1', sessionId: 'session-abc', tokenId: token });
  });

  it('should reject session when token hash mismatch', async () => {
    const token = issueToken({ subject: 'user-1', additionalPayload: { sid: 'session-abc' }, expiresIn: '1h' });

    const fakeSessionRepo = {
      findById: jest.fn().mockResolvedValueOnce({
        id: 'session-abc',
        user_id: 'user-1',
        token_hash: 'wrong-hash',
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        created_at: new Date(),
      }),
    } as any;

    const requireAuth = createRequireAuth(fakeSessionRepo);
    const next = jest.fn();
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = { status: statusMock, json: jsonMock } as unknown as Response;

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
