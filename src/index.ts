import 'dotenv/config';
import { createApp } from './app';
import { dbHealth, closePool } from './db/client';
import { pool } from './db/pool';

const app = createApp();
const port = Number(process.env.PORT || 3000);

app.get('/health', async (_req, res) => {
  const db = await dbHealth();
  res.status(db.healthy ? 200 : 503).json({
    status: db.healthy ? 'ok' : 'degraded',
    service: 'revora-backend',
    db,
  });
});

app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Readiness check failed:', err);
    res.status(503).json({ status: 'degraded' });
  }
});

const shutdown = async (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`\n[server] ${signal} shutting down…`);
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`revora-backend listening on http://localhost:${port}`);
});
