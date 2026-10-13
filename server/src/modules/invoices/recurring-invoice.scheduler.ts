import type { Pool } from 'pg';
import logger from '../../shared/logger';
import { RecurringInvoiceService } from './recurring-invoice.service';

/**
 * In-process scheduler for recurring invoice drafts: no external service, no extra cost. It runs shortly after start (catching up anything missed
 * while the server was down) and then hourly. Correctness never depends on it running exactly once: generation is idempotent per occurrence
 * (database unique index plus a row lock), so several processes or overlapping runs cannot create duplicates.
 * Disable with RECURRING_INVOICE_SCHEDULER=off. Generated invoices are drafts only.
 */
const FIRST_RUN_DELAY_MS = 30_000;
const INTERVAL_MS = 60 * 60 * 1000;

export function startRecurringInvoiceScheduler(pool: Pool, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (env['RECURRING_INVOICE_SCHEDULER'] === 'off' || env['NODE_ENV'] === 'test') return null;
  const service = new RecurringInvoiceService(pool);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await service.runAllDue();
      const generated = results.reduce((n, r) => n + r.generated.length, 0);
      const failed = results.filter((r) => r.error_code).length;
      if (generated || failed) logger.info({ generated, failed }, 'Recurring invoice run finished');
    } catch (err) {
      logger.error({ err }, 'Recurring invoice run failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
