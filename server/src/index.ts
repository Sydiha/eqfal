import app from './app';
import config from './config';
import logger from './shared/logger';
import pool from './db/pool';
import { runMigrations } from './db/migrate';

async function start(): Promise<void> {
  if (pool) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected');
      await runMigrations(pool);
    } catch (err) {
      logger.warn({ err }, 'Database not available — continuing without DB');
    }
  } else {
    logger.warn('DATABASE_URL not set — DB features disabled');
  }

  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'Server started');
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
