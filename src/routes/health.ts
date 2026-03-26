/**
 * Health Check and Readiness Endpoints
 * 
 * Provides Kubernetes-style health and readiness probes with comprehensive
 * dependency checking and metrics integration.
 * 
 * Endpoints:
 * - GET /health/live - Liveness probe (process is running)
 * - GET /health/ready - Readiness probe (dependencies are healthy)
 * - GET /health/metrics - Metrics snapshot (requires auth in production)
 * 
 * Security Assumptions:
 * - Health endpoints should be accessible without authentication for K8s probes
 * - Metrics endpoint should be protected or rate-limited in production
 * - Error messages should not leak sensitive infrastructure details
 * 
 * @module routes/health
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';

/**
 * Health check status
 */
export enum HealthStatus {
  /** Service is healthy and ready */
  OK = 'ok',
  /** Service is degraded but operational */
  DEGRADED = 'degraded',
  /** Service is unhealthy */
  ERROR = 'error',
}

/**
 * Dependency health check result
 */
export interface DependencyHealth {
  /** Dependency name */
  name: string;
  /** Health status */
  status: HealthStatus;
  /** Response time in milliseconds */
  latencyMs?: number;
  /** Error message if unhealthy */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Complete health check response
 */
export interface HealthCheckResponse {
  /** Overall service status */
  status: HealthStatus;
  /** Service name */
  service: string;
  /** Service version */
  version: string;
  /** Check timestamp */
  timestamp: string;
  /** Uptime in seconds */
  uptime: number;
  /** Dependency health checks */
  dependencies: DependencyHealth[];
}

/**
 * Liveness probe handler
 * 
 * Simple check that the process is running and responsive.
 * Always returns 200 OK unless the process is completely hung.
 * 
 * @param _req Express request
 * @param res Express response
 */
export const healthLiveHandler = (_req: Request, res: Response): void => {
  res.status(200).json({
    status: HealthStatus.OK,
    service: 'revora-backend',
    timestamp: new Date().toISOString(),
  });
};

/**
 * Check database connectivity and health
 * 
 * @param db PostgreSQL connection pool
 * @returns Database health check result
 */
async function checkDatabase(db: Pool): Promise<DependencyHealth> {
  const startTime = Date.now();
  
  try {
    // Simple connectivity check
    await db.query('SELECT 1');
    const latencyMs = Date.now() - startTime;

    // Get pool statistics
    const metadata = {
      totalConnections: db.totalCount,
      idleConnections: db.idleCount,
      activeConnections: db.totalCount - db.idleCount,
      waitingCount: db.waitingCount,
    };

    // Warn if pool is exhausted
    const status = db.waitingCount > 0 ? HealthStatus.DEGRADED : HealthStatus.OK;

    return {
      name: 'database',
      status,
      latencyMs,
      metadata,
    };
  } catch (error) {
    return {
      name: 'database',
      status: HealthStatus.ERROR,
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check Stellar Horizon connectivity
 * 
 * @param horizonUrl Stellar Horizon URL
 * @param timeoutMs Request timeout in milliseconds
 * @returns Stellar health check result
 */
async function checkStellarHorizon(horizonUrl: string, timeoutMs = 5000): Promise<DependencyHealth> {
  const startTime = Date.now();
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(horizonUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        name: 'stellar_horizon',
        status: HealthStatus.ERROR,
        latencyMs,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    // Check if response is valid JSON
    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return {
        name: 'stellar_horizon',
        status: HealthStatus.DEGRADED,
        latencyMs,
        error: 'Unexpected content type',
      };
    }

    return {
      name: 'stellar_horizon',
      status: HealthStatus.OK,
      latencyMs,
      metadata: {
        url: horizonUrl,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        name: 'stellar_horizon',
        status: HealthStatus.ERROR,
        latencyMs,
        error: `Timeout after ${timeoutMs}ms`,
      };
    }

    return {
      name: 'stellar_horizon',
      status: HealthStatus.ERROR,
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Readiness probe handler
 * 
 * Comprehensive check of all service dependencies.
 * Returns 200 OK only if all critical dependencies are healthy.
 * Returns 503 Service Unavailable if any critical dependency is down.
 * 
 * @param db PostgreSQL connection pool
 * @param logger Optional logger instance
 * @returns Express route handler
 */
export const healthReadyHandler = (db: Pool, logger?: Logger) => async (_req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const dependencies: DependencyHealth[] = [];

  // Check database
  const dbHealth = await checkDatabase(db);
  dependencies.push(dbHealth);

  // Check Stellar Horizon
  const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const stellarHealth = await checkStellarHorizon(horizonUrl);
  dependencies.push(stellarHealth);

  // Determine overall status
  const hasError = dependencies.some((dep) => dep.status === HealthStatus.ERROR);
  const hasDegraded = dependencies.some((dep) => dep.status === HealthStatus.DEGRADED);
  
  let overallStatus: HealthStatus;
  let statusCode: number;

  if (hasError) {
    overallStatus = HealthStatus.ERROR;
    statusCode = 503;
  } else if (hasDegraded) {
    overallStatus = HealthStatus.DEGRADED;
    statusCode = 200; // Still accept traffic but signal degradation
  } else {
    overallStatus = HealthStatus.OK;
    statusCode = 200;
  }

  const response: HealthCheckResponse = {
    status: overallStatus,
    service: 'revora-backend',
    version: process.env.npm_package_version || '0.1.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies,
  };

  // Log unhealthy states
  if (logger && overallStatus !== HealthStatus.OK) {
    logger.warn('Health check failed', {
      status: overallStatus,
      dependencies: dependencies.filter((d) => d.status !== HealthStatus.OK),
      durationMs: Date.now() - startTime,
    });
  }

  res.status(statusCode).json(response);
};

/**
 * Create health check router
 * 
 * @param db PostgreSQL connection pool
 * @param metrics Optional metrics collector
 * @param logger Optional logger instance
 * @returns Express router with health endpoints
 */
export const createHealthRouter = (
  db: Pool,
  metrics?: MetricsCollector,
  logger?: Logger
): Router => {
  const router = Router();

  // Liveness probe - simple check that process is running
  router.get('/live', healthLiveHandler);

  // Readiness probe - comprehensive dependency checks
  router.get('/ready', healthReadyHandler(db, logger));

  // Metrics endpoint (if metrics collector provided)
  if (metrics) {
    router.get('/metrics', async (_req: Request, res: Response) => {
      try {
        const snapshot = await metrics.getSnapshot(db);
        res.status(200).json(snapshot);
      } catch (error) {
        if (logger) {
          logger.error('Failed to collect metrics', { error });
        }
        res.status(500).json({
          error: 'Failed to collect metrics',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  return router;
};

export default createHealthRouter;
