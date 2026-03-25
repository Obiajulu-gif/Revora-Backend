import 'dotenv/config';
import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { createApp } from './app';
import { dbHealth, closePool } from './db/client';
import { pool } from './db/pool';

// Use existing app factory (from auth hardening)
const app = createApp();
const port = Number(process.env.PORT || 3000);

/**
 * API Versioning
 */
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';
const apiRouter = express.Router();

/**
 * Middleware setup
 */
app.use(express.json());
app.use(morgan('dev'));
app.use(API_VERSION_PREFIX, apiRouter);

/**
 * Health check (global, no prefix)
 */
app.get('/health', async (_req: Request, res: Response) => {
  const db = await dbHealth();
  res.status(db.healthy ? 200 : 503).json({
    status: db.healthy ? 'ok' : 'degraded',
    service: 'revora-backend',
    db,
  });
});

/**
 * Readiness check (from auth hardening)
 */
app.get('/ready', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Readiness check failed:', err);
    res.status(503).json({ status: 'degraded' });
  }
});

/**
 * Example API route (from master branch)
 */
apiRouter.get('/overview', (_req: Request, res: Response) => {
  res.json({
    name: "Stellar RevenueShare (Revora) Backend",
    description:
      "Backend API skeleton for tokenized revenue-sharing on Stellar.",
  });
});

/**
 * Graceful shutdown
 */
const shutdown = async (signal: string) => {
  console.log(`\n[server] ${signal} shutting down…`);
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Start server (skip during tests)
 */
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`revora-backend listening on http://localhost:${port}`);
  });
}

export default app;