import type { Pool } from 'pg';
import logger from '../../shared/logger';
import { getStorage } from '../../storage/storage.factory';
import config from '../../config';
import { DocumentFileCleanup } from './document-file-cleanup';

/** Same in-process pattern as the recurring invoice scheduler (no new infrastructure): retries pending file removals shortly after start, then every 10 minutes. Disable with DOCUMENT_FILE_CLEANUP=off. */
const FIRST_RUN_DELAY_MS = 45_000;
const INTERVAL_MS = 10 * 60 * 1000;

export function startDocumentFileCleanupScheduler(pool: Pool, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (env['DOCUMENT_FILE_CLEANUP'] === 'off' || env['NODE_ENV'] === 'test') return null;
  const cleanup = new DocumentFileCleanup(pool, getStorage('documents', config.documentStorageDir), { 'bank-imports': getStorage('bank-imports', config.bankStorageDir) });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await cleanup.process();
      if (result.done || result.pending || result.skipped) logger.info(result, 'Document file cleanup run finished');
    } catch (err) {
      logger.error({ err }, 'Document file cleanup run failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
