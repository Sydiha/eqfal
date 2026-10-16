import app from './app';
import config from './config';
import logger from './shared/logger';
import pool from './db/pool';
import { runMigrations } from './db/migrate';
import { frontendBuildAvailable } from './shared/frontend-static';
import { assertStorageConfig, verifyStorageReady } from './storage/storage.factory';
import { startRecurringInvoiceScheduler } from './modules/invoices/recurring-invoice.scheduler';
import { startDocumentFileCleanupScheduler } from './modules/documents/document-file-cleanup.scheduler';
import { assertProductionConfig, productionConfigWarnings } from './config/production-config';

async function start(): Promise<void> {
  assertProductionConfig();
  assertStorageConfig(process.env);
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
      // The posting guard reads this table on every journal post: fail closed at start-up rather than reject postings at run time.
      const ready = await pool.query("SELECT to_regclass('public.ledger_source_authority') IS NOT NULL AS ok");
      if (!ready.rows[0]?.ok) throw new Error('ledger_source_authority table is missing (migration 083 not applied)');
    } catch (err) {
      logger.error({ err }, 'Database startup failed — aborting');
      throw err; // propagates to start().catch → process.exit(1)
    }
  } else {
    logger.warn('DATABASE_URL not set — DB features disabled');
  }

  // Object storage must be reachable before serving traffic; failure aborts startup (no local fallback).
  await verifyStorageReady({ documents: config.documentStorageDir, 'bank-imports': config.bankStorageDir });

  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'Server started');
  });
  if (pool && startRecurringInvoiceScheduler(pool)) logger.info('Recurring invoice scheduler started (drafts only)');
  if (pool && startDocumentFileCleanupScheduler(pool)) logger.info('Document file cleanup scheduler started');
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
