import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { startRecurringInvoiceScheduler } from '../src/modules/invoices/recurring-invoice.scheduler';

describe('recurring invoice scheduler switch', () => {
  afterEach(() => vi.useRealTimers());
  const pool = () => ({ query: vi.fn(), connect: vi.fn() }) as unknown as Pool & { query: ReturnType<typeof vi.fn> };

  it.each([[{ RECURRING_INVOICE_SCHEDULER: 'off', NODE_ENV: 'production' }], [{ NODE_ENV: 'test' }]])('does not start (and never touches the database) for %j', (env) => {
    vi.useFakeTimers();
    const p = pool();
    expect(startRecurringInvoiceScheduler(p, env as NodeJS.ProcessEnv)).toBeNull();
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    expect(p.query).not.toHaveBeenCalled();
  });

  it('when enabled it waits 30 seconds after start before the first run, and stop() cancels it', async () => {
    vi.useFakeTimers();
    const p = pool();
    p.query.mockResolvedValue({ rows: [] });
    const stop = startRecurringInvoiceScheduler(p, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)!;
    expect(stop).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(p.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.query).toHaveBeenCalledTimes(1);
    expect(String(p.query.mock.calls[0]![0])).toContain("status='active'");
    stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(p.query).toHaveBeenCalledTimes(1);
  });
});
