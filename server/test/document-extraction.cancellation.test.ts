import { afterEach, describe, expect, it, vi } from 'vitest';

// pdf.js is replaced by a controllable fake so a parse can be held open past the timeout deterministically.
const fake = vi.hoisted(() => ({ tasks: [] as Array<{ destroy: ReturnType<typeof vi.fn>; settle: (err: Error) => void }>, settleOnDestroy: true }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  VerbosityLevel: { ERRORS: 0 },
  getDocument: () => {
    let reject!: (err: Error) => void;
    const promise = new Promise((_resolve, r) => { reject = r; });
    const entry = { settle: reject, destroy: vi.fn(async () => { if (fake.settleOnDestroy) reject(new Error('destroyed')); }) };
    fake.tasks.push(entry);
    return { promise, destroy: entry.destroy };
  },
}));

import { EXTRACTION_LIMITS, activeExtractions, extractInvoiceSuggestions } from '../src/modules/documents/document-extraction';

const pdf = Buffer.from('%PDF-1.7 stub');
const limits = { ...EXTRACTION_LIMITS, timeoutMs: 20, maxConcurrent: 1 };

afterEach(async () => {
  for (const task of fake.tasks) task.settle(new Error('cleanup'));
  fake.tasks.length = 0; fake.settleOnDestroy = true;
  await vi.waitFor(() => expect(activeExtractions()).toBe(0));
});

describe('T7.1 extraction timeout and cancellation', () => {
  it('answers timeout, destroys the pdf.js task and frees the slot only once the work has stopped', async () => {
    expect(await extractInvoiceSuggestions(pdf, limits)).toEqual({ status: 'timeout', fields: null });
    expect(fake.tasks[0]!.destroy).toHaveBeenCalled();
    await vi.waitFor(() => expect(activeExtractions()).toBe(0));
    expect((await extractInvoiceSuggestions(pdf, limits)).status).toBe('timeout');
  });

  it('keeps a timed-out parse that has not stopped counted, so it cannot bypass the concurrency limit', async () => {
    fake.settleOnDestroy = false; // simulate cancellation that has not finished yet
    expect((await extractInvoiceSuggestions(pdf, limits)).status).toBe('timeout');
    expect(activeExtractions()).toBe(1);
    expect(await extractInvoiceSuggestions(pdf, limits)).toEqual({ status: 'busy', fields: null });
    expect(fake.tasks).toHaveLength(1); // no second parse was started
    fake.tasks[0]!.settle(new Error('stopped'));
    await vi.waitFor(() => expect(activeExtractions()).toBe(0));
  });
});
