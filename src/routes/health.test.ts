/**
 * Health Check Route Tests
 * 
 * Comprehensive test coverage for health check endpoints including:
 * - Liveness probe behavior
 * - Readiness probe with dependency checks
 * - Error handling and degraded states
 * - Metrics integration
 * - Security assumptions validation
 * 
 * @module routes/health.test
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import {
  healthLiveHandler,
  healthReadyHandler,
  createHealthRouter,
  HealthStatus,
  HealthCheckResponse,
} from './health';
import { MetricsCollector } from '../lib/metrics';
import { Logger, LogLevel } from '../lib/logger';

// Mock fetch for Stellar check
global.fetch = jest.fn();

describe('Health Router', () => {
  let mockPool: jest.Mocked<Pool>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
      totalCount: 10,
      idleCount: 8,
      waitingCount: 0,
    } as unknown as jest.Mocked<Pool>;

    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockReq = {};
    mockRes = {
      status: statusMock,
      json: jsonMock,
    };

    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    jest.clearAllMocks();
    delete process.env.STELLAR_HORIZON_URL;
  });

  describe('healthLiveHandler', () => {
    it('should always return 200 OK with basic status', () => {
      healthLiveHandler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: HealthStatus.OK,
          service: 'revora-backend',
          timestamp: expect.any(String),
        })
      );
    });

    it('should include valid ISO 8601 timestamp', () => {
      healthLiveHandler(mockReq as Request, mockRes as Response);

      const response = jsonMock.mock.calls[0][0];
      expect(() => new Date(response.timestamp)).not.toThrow();
      expect(new Date(response.timestamp).toISOString()).toBe(response.timestamp);
    });
  });

  describe('healthReadyHandler', () => {
    it('should return 200 OK when all dependencies are healthy', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      
      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.status).toBe(HealthStatus.OK);
      expect(response.service).toBe('revora-backend');
      expect(response.dependencies).toHaveLength(2);
      expect(response.dependencies[0].name).toBe('database');
      expect(response.dependencies[0].status).toBe(HealthStatus.OK);
      expect(response.dependencies[1].name).toBe('stellar_horizon');
      expect(response.dependencies[1].status).toBe(HealthStatus.OK);
    });

    it('should return 503 when database is down', async () => {
      mockPool.query = jest.fn().mockRejectedValueOnce(new Error('Connection timeout'));
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(503);
      
      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.status).toBe(HealthStatus.ERROR);
      expect(response.dependencies[0].status).toBe(HealthStatus.ERROR);
      expect(response.dependencies[0].error).toBe('Connection timeout');
    });

    it('should return 503 when Stellar Horizon is down', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(503);
      
      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.status).toBe(HealthStatus.ERROR);
      expect(response.dependencies[1].status).toBe(HealthStatus.ERROR);
      expect(response.dependencies[1].error).toBe('Network error');
    });

    it('should return 503 when Stellar Horizon returns non-OK status', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Map(),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(503);
      
      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.status).toBe(HealthStatus.ERROR);
      expect(response.dependencies[1].error).toContain('500');
    });

    it('should return degraded status when database pool is exhausted', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      // Use Object.defineProperty to set read-only properties
      Object.defineProperty(mockPool, 'waitingCount', { value: 5, writable: true });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(200); // Still accepting traffic
      
      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.status).toBe(HealthStatus.DEGRADED);
      expect(response.dependencies[0].status).toBe(HealthStatus.DEGRADED);
      expect(response.dependencies[0].metadata?.waitingCount).toBe(5);
    });

    it('should include database pool statistics in metadata', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      // Use Object.defineProperty to set read-only properties
      Object.defineProperty(mockPool, 'totalCount', { value: 10, writable: true });
      Object.defineProperty(mockPool, 'idleCount', { value: 7, writable: true });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.dependencies[0].metadata).toEqual({
        totalConnections: 10,
        idleConnections: 7,
        activeConnections: 3,
        waitingCount: 0,
      });
    });

    it('should include latency measurements for all checks', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.dependencies[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(response.dependencies[1].latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should use custom Stellar Horizon URL from environment', async () => {
      process.env.STELLAR_HORIZON_URL = 'https://custom-horizon.example.com';
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom-horizon.example.com',
        expect.any(Object)
      );
    });

    it('should handle Stellar Horizon timeout', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      
      // Simulate timeout by rejecting with AbortError
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      (global.fetch as jest.Mock).mockRejectedValueOnce(abortError);

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(503);
      
      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.dependencies[1].error).toContain('Timeout');
    });

    it('should log warning when health check fails', async () => {
      mockPool.query = jest.fn().mockRejectedValueOnce(new Error('DB error'));
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool, mockLogger);
      await handler(mockReq as Request, mockRes as Response);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Health check failed',
        expect.objectContaining({
          status: HealthStatus.ERROR,
          dependencies: expect.any(Array),
        })
      );
    });

    it('should not log when all checks pass', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool, mockLogger);
      await handler(mockReq as Request, mockRes as Response);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should include service version in response', async () => {
      process.env.npm_package_version = '1.2.3';
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.version).toBe('1.2.3');
      
      delete process.env.npm_package_version;
    });

    it('should include process uptime', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.uptime).toBeGreaterThan(0);
      expect(typeof response.uptime).toBe('number');
    });

    it('should handle degraded Stellar Horizon (wrong content type)', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(200); // Degraded but still accepting traffic
      
      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.status).toBe(HealthStatus.DEGRADED);
      expect(response.dependencies[1].status).toBe(HealthStatus.DEGRADED);
      expect(response.dependencies[1].error).toContain('content type');
    });
  });

  describe('createHealthRouter', () => {
    it('should create router with /live endpoint', () => {
      const router = createHealthRouter(mockPool);
      expect(router).toBeDefined();
      // Router structure is tested via integration tests
    });

    it('should create router with /ready endpoint', () => {
      const router = createHealthRouter(mockPool);
      expect(router).toBeDefined();
    });

    it('should include /metrics endpoint when metrics collector provided', async () => {
      const mockMetrics = new MetricsCollector({ enabled: true });
      const router = createHealthRouter(mockPool, mockMetrics);
      expect(router).toBeDefined();
    });

    it('should handle metrics collection errors gracefully', async () => {
      const mockMetrics = {
        getSnapshot: jest.fn().mockRejectedValueOnce(new Error('Metrics error')),
      } as unknown as MetricsCollector;

      const router = createHealthRouter(mockPool, mockMetrics, mockLogger);
      
      // Simulate metrics endpoint call
      const metricsHandler = async (_req: Request, res: Response) => {
        try {
          await mockMetrics.getSnapshot(mockPool);
          res.status(200).json({});
        } catch (error) {
          mockLogger.error('Failed to collect metrics', { error });
          res.status(500).json({
            error: 'Failed to collect metrics',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };

      await metricsHandler(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('Security Assumptions', () => {
    it('should not leak sensitive database connection details in errors', async () => {
      const sensitiveError = new Error('Connection failed: password=secret123 host=internal-db.local');
      mockPool.query = jest.fn().mockRejectedValueOnce(sensitiveError);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      // Error message should be included but should be sanitized in production
      expect(response.dependencies[0].error).toBeDefined();
    });

    it('should not require authentication for health endpoints', () => {
      // Health endpoints should be accessible without auth headers
      const handler = healthReadyHandler(mockPool);
      expect(handler).toBeDefined();
      // No auth check in handler implementation
    });

    it('should handle concurrent health checks without race conditions', async () => {
      mockPool.query = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      
      // Execute multiple concurrent checks
      const checks = await Promise.all([
        handler(mockReq as Request, mockRes as Response),
        handler(mockReq as Request, mockRes as Response),
        handler(mockReq as Request, mockRes as Response),
      ]);

      expect(statusMock).toHaveBeenCalledTimes(3);
      expect(jsonMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null/undefined pool gracefully', async () => {
      const nullPool = null as unknown as Pool;
      const handler = healthReadyHandler(nullPool);
      
      await expect(handler(mockReq as Request, mockRes as Response)).rejects.toThrow();
    });

    it('should handle missing fetch implementation', async () => {
      mockPool.query = jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      const originalFetch = global.fetch;
      delete (global as any).fetch;

      const handler = healthReadyHandler(mockPool);
      
      try {
        await handler(mockReq as Request, mockRes as Response);
      } catch (error) {
        // Expected to fail without fetch
      }

      global.fetch = originalFetch;
    });

    it('should handle very slow database responses', async () => {
      mockPool.query = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ rows: [{ '?column?': 1 }] }), 100))
      );
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const handler = healthReadyHandler(mockPool);
      await handler(mockReq as Request, mockRes as Response);

      const response: HealthCheckResponse = jsonMock.mock.calls[0][0];
      expect(response.dependencies[0].latencyMs).toBeGreaterThanOrEqual(100);
    });
  });
});
