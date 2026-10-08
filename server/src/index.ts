import app from './app';
import config from './config';
import logger from './shared/logger';
import pool from './db/pool';
import { runMigrations } from './db/migrate';
import { frontendBuildAvailable } from './shared/frontend-static';
import { assertProductionConfig, productionConfigWarnings } from './config/production-config';

async function start(): Promise<void> {
  assertProductionConfig();
  if (config.env === 'production' && !frontendBuildAvailable(config.frontendDistDir)) {
    throw new Error('Frontend build not found: run `npm run build` before `npm start` (expected index.html in the client dist directory)');
  }
  for (const warning of productionConfigWarnings(process.env)) logger.warn(warning);
  if (pool) {
    // DATABASE_URL is set: a connection or migration failure is fatal.
    // Continuing with an unknown schema state risks silent data corruption.
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected');
      await runMigrations(pool);
    } catch (err) {
      logger.error({ err }, 'Database startup failed — aborting');
      throw err; // propagates to start().catch → process.exit(1)
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
